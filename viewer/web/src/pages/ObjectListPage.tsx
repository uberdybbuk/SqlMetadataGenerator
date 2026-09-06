import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { api, type ObjectSummary } from "../api";
import { useApi } from "../useApi";
import { plural } from "../format";
import { DataTable, type Column } from "../DataTable";
import { formatCell } from "../cell";
import { Icon, type IconName } from "../Icon";

// The sections this page serves. Tables have their own page (sizes, treemap, drill-down), so
// they are deliberately absent; schemas come from the dashboard response rather than the object
// list, because sys.schemas is not sys.objects.
const SECTIONS: Record<string, { title: string; singular: string; icon: IconName }> = {
    views: { title: "Views", singular: "view", icon: "view" },
    procedures: { title: "Procedures", singular: "procedure", icon: "procedure" },
    functions: { title: "Functions", singular: "function", icon: "function" },
    triggers: { title: "Triggers", singular: "trigger", icon: "trigger" },
    synonyms: { title: "Synonyms", singular: "synonym", icon: "synonym" },
    sequences: { title: "Sequences", singular: "sequence", icon: "sequence" },
    types: { title: "Types", singular: "type", icon: "type" },
};

// SQL_STORED_PROCEDURE -> stored procedure. The counter lumps the four function kinds together;
// type_desc is what tells a scalar function from a table-valued one.
function readableType(typeDesc: string): string {
    return typeDesc.replace(/^SQL_/, "").replace(/_/g, " ").toLowerCase();
}

export function ObjectListPage() {
    const { alias = "", db = "", section = "" } = useParams();
    const known = SECTIONS[section];
    const { data, error, loading } = useApi(
        () => api.objects(alias, db, section),
        [alias, db, section],
        Boolean(known),
    );
    const [search, setSearch] = useState("");

    const rows = useMemo(() => {
        const needle = search.trim().toLowerCase();
        return (data ?? []).filter(
            (o) =>
                !needle ||
                o.name.toLowerCase().includes(needle) ||
                o.schema.toLowerCase().includes(needle),
        );
    }, [data, search]);

    if (!known) {
        return <div className="error">Unknown section: {section}</div>;
    }

    const showParent = section === "triggers";
    const columns: Column<ObjectSummary>[] = [
        {
            key: "schema",
            header: "Schema",
            sortValue: (o) => o.schema,
            render: (o) => <span className="mono muted">{o.schema}</span>,
        },
        {
            key: "name",
            header: known.title.replace(/s$/, ""),
            sortValue: (o) => o.name,
            render: (o) => (
                <Link
                    className="mono with-icon"
                    to={`/app/${encodeURIComponent(alias)}/${encodeURIComponent(db)}/${section}/${encodeURIComponent(o.schema)}/${encodeURIComponent(o.name)}`}
                >
                    <Icon name={known.icon} />
                    {o.name}
                </Link>
            ),
        },
        ...(showParent
            ? [
                  {
                      key: "parent",
                      header: "Table",
                      sortValue: (o: ObjectSummary) => o.parent ?? "",
                      render: (o: ObjectSummary) => <span className="mono">{o.parent}</span>,
                  },
              ]
            : []),
        {
            key: "type",
            header: "Type",
            sortValue: (o) => o.typeDesc,
            render: (o) => <span className="muted">{readableType(o.typeDesc)}</span>,
        },
        {
            key: "modified",
            header: "Modified",
            sortValue: (o) => o.modifyDate,
            render: (o) => formatCell(o.modifyDate, "datetime2"),
        },
    ];

    return (
        <>
            <h1>{known.title}</h1>
            <p className="subtitle">
                <span className="mono">{db}</span> database ·{" "}
                {loading ? "reading…" : `${rows.length} of ${data?.length ?? 0}`}{" "}
                {plural(data?.length ?? 0, known.singular)}
            </p>

            {error && <div className="error">{error}</div>}
            {loading && <div className="state">Reading {known.title.toLowerCase()}…</div>}

            {!loading && !error && (
                <>
                    <div className="toolbar">
                        <input
                            className="search"
                            placeholder={`Search ${known.title.toLowerCase()} or schemas…`}
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                    </div>
                    <DataTable
                        columns={columns}
                        rows={rows}
                        rowKey={(o) => `${o.schema}.${o.name}`}
                        initialSort={{ key: "name" }}
                        dense
                    />
                    {rows.length === 0 && (
                        <div className="state">No matching {known.title.toLowerCase()}.</div>
                    )}
                </>
            )}
        </>
    );
}

// Schemas do not live in sys.objects, so they get their own small page. The owner comes from the
// dashboard response and the table count from the statistics the treemap already uses, which
// makes an empty schema visible as such rather than simply absent.
export function SchemaListPage() {
    const { alias = "", db = "" } = useParams();
    const overview = useApi(() => api.database(alias, db), [alias, db]);
    const tables = useApi(() => api.tables(alias, db), [alias, db]);

    const counts = useMemo(() => {
        const map = new Map<string, number>();
        for (const t of tables.data ?? []) {
            map.set(t.schema, (map.get(t.schema) ?? 0) + 1);
        }
        return map;
    }, [tables.data]);

    const rows = overview.data?.schemas ?? [];
    const base = `/app/${encodeURIComponent(alias)}/${encodeURIComponent(db)}`;

    const columns: Column<{ name: string; owner: string }>[] = [
        {
            key: "name",
            header: "Schema",
            sortValue: (s) => s.name,
            render: (s) => (
                <Link className="mono" to={`${base}/tables/${encodeURIComponent(s.name)}`}>
                    {s.name}
                </Link>
            ),
        },
        {
            key: "owner",
            header: "Owner",
            sortValue: (s) => s.owner,
            render: (s) => <span className="mono muted">{s.owner}</span>,
        },
        {
            key: "tables",
            header: "Tables",
            numeric: true,
            sortValue: (s) => counts.get(s.name) ?? 0,
            render: (s) => counts.get(s.name) ?? 0,
        },
    ];

    return (
        <>
            <h1>Schemas</h1>
            <p className="subtitle">
                <span className="mono">{db}</span> database · {rows.length} {plural(rows.length, "schema")}
            </p>

            {overview.error && <div className="error">{overview.error}</div>}
            {overview.loading && <div className="state">Reading schemas…</div>}

            {!overview.loading && !overview.error && (
                <DataTable
                    columns={columns}
                    rows={rows}
                    rowKey={(s) => s.name}
                    initialSort={{ key: "tables", desc: true }}
                    dense
                />
            )}
        </>
    );
}
