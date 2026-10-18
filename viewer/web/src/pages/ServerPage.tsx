import { Link, useParams } from "react-router-dom";

import { api } from "../api";
import { useApi } from "../useApi";
import { formatDate, formatMb, plural } from "../format";
import { DataTable, type Column } from "../DataTable";
import type { DatabaseInfo } from "../api";
import { Icon } from "../Icon";

export function ServerPage() {
    const { alias = "" } = useParams();
    const { data, error, loading } = useApi(() => api.server(alias), [alias]);
    // The alias alone does not say which server you are looking at; show the real address too.
    const connections = useApi(() => api.connections(), []);

    if (loading) {
        return <div className="state">Reading server…</div>;
    }
    if (error) {
        return <div className="error">{error}</div>;
    }
    if (!data) {
        return null;
    }

    const { server, databases } = data;
    const connection = connections.data?.find((c) => c.alias.toLowerCase() === alias.toLowerCase());
    const totalMb = databases.reduce((sum, db) => sum + db.dataMb, 0);

    // A column every row leaves empty is noise. PostgreSQL has no recovery model, no separate
    // log file and no creation timestamp in the catalog, so those three headers would sit over a
    // column of dashes; this drops them instead of explaining them.
    const has = (pick: (db: DatabaseInfo) => unknown) => databases.some((db) => pick(db) !== null);

    const columns: Column<DatabaseInfo>[] = [
        {
            key: "name",
            header: "Database",
            grow: true,
            sortValue: (db) => db.name,
            render: (db) =>
                db.isBrowsable ? (
                    <Link
                        className="mono with-icon"
                        to={`/app/${encodeURIComponent(alias)}/${encodeURIComponent(db.name)}`}
                    >
                        <Icon name="database" />
                        {db.name}
                    </Link>
                ) : (
                    <span className="mono muted with-icon">
                        <Icon name="database" />
                        {db.name}
                    </span>
                ),
        },
        { key: "data", header: "Data", numeric: true, sortValue: (db) => db.dataMb, render: (db) => formatMb(db.dataMb) },
        ...(has((db) => db.logMb)
            ? [{
                  key: "log",
                  header: "Log",
                  numeric: true,
                  sortValue: (db: DatabaseInfo) => db.logMb ?? -1,
                  render: (db: DatabaseInfo) => formatMb(db.logMb),
              } satisfies Column<DatabaseInfo>]
            : []),
        {
            key: "state",
            header: "State",
            sortValue: (db) => db.state,
            copyValue: (db) => db.state.toLowerCase(),
            render: (db) =>
                db.state === "ONLINE" ? <span className="muted">online</span> : <span className="pill">{db.state.toLowerCase()}</span>,
        },
        ...(has((db) => db.recoveryModel)
            ? [{
                  key: "recovery",
                  header: "Recovery",
                  sortValue: (db: DatabaseInfo) => db.recoveryModel ?? "",
                  copyValue: (db: DatabaseInfo) => db.recoveryModel?.toLowerCase() ?? "",
                  render: (db: DatabaseInfo) => <span className="muted">{db.recoveryModel?.toLowerCase() ?? "—"}</span>,
                  className: "muted",
              } satisfies Column<DatabaseInfo>]
            : []),
        {
            key: "collation",
            header: "Collation",
            sortValue: (db) => db.collation,
            render: (db) => <span className="muted mono" style={{ fontSize: 12 }}>{db.collation ?? "—"}</span>,
        },
        ...(has((db) => db.createDate)
            ? [{
                  key: "created",
                  header: "Created",
                  sortValue: (db: DatabaseInfo) => db.createDate ?? "",
                  copyType: "datetime2" as const,
                  render: (db: DatabaseInfo) => (
                      <span className="muted mono" style={{ fontSize: 12 }}>{formatDate(db.createDate)}</span>
                  ),
              } satisfies Column<DatabaseInfo>]
            : []),
    ];

    return (
        <>
            <h1>{alias}</h1>
            <p className="subtitle">
                <span className="mono">{connection?.server ?? "—"}</span>
                {connection?.user && <> · {connection.user}</>}
                {connection?.description && <> · {connection.description}</>}
                <br />
                {server.product} {server.productVersion} {server.productLevel} · {server.edition} ·{" "}
                {server.collation} · machine {server.machineName}
            </p>

            <div className="badges">
                <span className="badge">
                    <b>{databases.length}</b> {plural(databases.length, "database")}
                </span>
                <span className="badge">
                    <b>{formatMb(totalMb)}</b> total data
                </span>
            </div>

            <DataTable
                columns={columns}
                rows={databases}
                rowKey={(db) => db.name}
                initialSort={{ key: "data", desc: true }}
                dense
                resizable
            />
            <p className="subtitle" style={{ marginTop: 12 }}>
                {server.product === "PostgreSQL" ? (
                    <>Sizes come from <code>pg_database_size</code>: what the database occupies on disk.</>
                ) : (
                    <>Sizes come from <code>sys.master_files</code>: allocated file size, not space in use.</>
                )}
            </p>
        </>
    );
}
