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
    // Alias tek başına hangi sunucuya baktığını söylemiyor; gerçek adresi de göster.
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

    const columns: Column<DatabaseInfo>[] = [
        {
            key: "name",
            header: "Database",
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
        { key: "log", header: "Log", numeric: true, sortValue: (db) => db.logMb, render: (db) => formatMb(db.logMb) },
        {
            key: "state",
            header: "State",
            sortValue: (db) => db.state,
            render: (db) =>
                db.state === "ONLINE" ? <span className="muted">online</span> : <span className="pill">{db.state.toLowerCase()}</span>,
        },
        {
            key: "recovery",
            header: "Recovery",
            sortValue: (db) => db.recoveryModel,
            render: (db) => <span className="muted">{db.recoveryModel.toLowerCase()}</span>,
            className: "muted",
        },
        {
            key: "collation",
            header: "Collation",
            sortValue: (db) => db.collation,
            render: (db) => <span className="muted mono" style={{ fontSize: 12 }}>{db.collation ?? "—"}</span>,
        },
        {
            key: "created",
            header: "Created",
            sortValue: (db) => db.createDate,
            render: (db) => <span className="muted mono" style={{ fontSize: 12 }}>{formatDate(db.createDate)}</span>,
        },
    ];

    return (
        <>
            <h1>{alias}</h1>
            <p className="subtitle">
                <span className="mono">{connection?.server ?? "—"}</span>
                {connection?.user && <> · {connection.user}</>}
                {connection?.description && <> · {connection.description}</>}
                <br />
                SQL Server {server.productVersion} {server.productLevel} · {server.edition} ·{" "}
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
            />
            <p className="subtitle" style={{ marginTop: 12 }}>
                Sizes come from <code>sys.master_files</code>: allocated file size, not space in use.
            </p>
        </>
    );
}
