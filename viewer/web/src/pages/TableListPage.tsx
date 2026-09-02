import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { api, type TableStats } from "../api";
import { useApi } from "../useApi";
import { formatKb, formatRows, plural } from "../format";
import { DataTable, type Column } from "../DataTable";
import { Icon } from "../Icon";

export function TableListPage() {
    const { alias = "", db = "", schema } = useParams();
    const navigate = useNavigate();
    const { data, error, loading } = useApi(() => api.tables(alias, db), [alias, db]);
    const [search, setSearch] = useState("");

    const base = `/app/${encodeURIComponent(alias)}/${encodeURIComponent(db)}`;
    const rows = data ?? [];

    const schemas = useMemo(
        () => [...new Set(rows.map((t) => t.schema))].sort((a, b) => a.localeCompare(b, "en")),
        [rows],
    );

    const shown = useMemo(() => {
        const needle = search.trim().toLowerCase();
        return rows.filter(
            (t) =>
                (!schema || t.schema === schema) &&
                (!needle ||
                    t.name.toLowerCase().includes(needle) ||
                    t.schema.toLowerCase().includes(needle)),
        );
    }, [rows, schema, search]);

    const columns: Column<TableStats>[] = [
        {
            key: "schema",
            header: "Schema",
            sortValue: (t) => t.schema,
            render: (t) => (
                <Link className="mono muted with-icon" to={`${base}/tables/${encodeURIComponent(t.schema)}`}>
                    <Icon name="schema" />
                    {t.schema}
                </Link>
            ),
        },
        {
            key: "name",
            header: "Table",
            sortValue: (t) => t.name,
            render: (t) => (
                <Link
                    className="mono with-icon"
                    to={`${base}/tables/${encodeURIComponent(t.schema)}/${encodeURIComponent(t.name)}`}
                >
                    <Icon name="table" />
                    {t.name}
                </Link>
            ),
        },
        {
            key: "rows",
            header: "Rows",
            numeric: true,
            sortValue: (t) => t.rowCount,
            render: (t) => formatRows(t.rowCount),
        },
        {
            key: "reserved",
            header: "Allocated",
            numeric: true,
            sortValue: (t) => t.reservedKb,
            render: (t) => formatKb(t.reservedKb),
        },
        {
            key: "used",
            header: "Used",
            numeric: true,
            sortValue: (t) => t.usedKb,
            render: (t) => <span className="muted">{formatKb(t.usedKb)}</span>,
        },
    ];

    if (loading) {
        return <div className="state">Reading tables…</div>;
    }
    if (error) {
        return <div className="error">{error}</div>;
    }

    return (
        <>
            <h1>{schema ? `Tables in ${schema}` : "Tables"}</h1>
            <p className="subtitle">
                <span className="mono">{db}</span> database · {shown.length} of {rows.length}{" "}
                {plural(rows.length, "table")}
            </p>

            <div className="toolbar">
                <input
                    type="search"
                    placeholder="Search tables or schemas…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
                <button className="chip" aria-pressed={!schema} onClick={() => navigate(`${base}/tables`)}>
                    all
                </button>
                {schemas.map((s) => (
                    <button
                        key={s}
                        className="chip"
                        aria-pressed={schema === s}
                        onClick={() =>
                            navigate(schema === s ? `${base}/tables` : `${base}/tables/${encodeURIComponent(s)}`)
                        }
                    >
                        {s}
                    </button>
                ))}
            </div>

            <DataTable
                columns={columns}
                rows={shown}
                rowKey={(t) => `${t.schema}.${t.name}`}
                initialSort={{ key: "reserved", desc: true }}
            />
            {shown.length === 0 && <div className="state">No matching tables.</div>}
        </>
    );
}
