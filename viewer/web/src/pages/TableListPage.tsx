import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { api, type TableStats } from "../api";
import { useApi } from "../useApi";
import { formatKb, formatRows } from "../format";
import { DataTable, type Column } from "../DataTable";

export function TableListPage() {
    const { alias = "", db = "", schema } = useParams();
    const navigate = useNavigate();
    const { data, error, loading } = useApi(() => api.tables(alias, db), [alias, db]);
    const [search, setSearch] = useState("");

    const base = `/app/${encodeURIComponent(alias)}/${encodeURIComponent(db)}`;
    const rows = data ?? [];

    const schemas = useMemo(
        () => [...new Set(rows.map((t) => t.schema))].sort((a, b) => a.localeCompare(b, "tr")),
        [rows],
    );

    const shown = useMemo(() => {
        const needle = search.trim().toLocaleLowerCase("tr");
        return rows.filter(
            (t) =>
                (!schema || t.schema === schema) &&
                (!needle ||
                    t.name.toLocaleLowerCase("tr").includes(needle) ||
                    t.schema.toLocaleLowerCase("tr").includes(needle)),
        );
    }, [rows, schema, search]);

    const columns: Column<TableStats>[] = [
        {
            key: "schema",
            header: "Şema",
            sortValue: (t) => t.schema,
            render: (t) => (
                <Link className="mono muted" to={`${base}/tables/${encodeURIComponent(t.schema)}`}>
                    {t.schema}
                </Link>
            ),
        },
        {
            key: "name",
            header: "Tablo",
            sortValue: (t) => t.name,
            render: (t) => (
                <Link
                    className="mono"
                    to={`${base}/tables/${encodeURIComponent(t.schema)}/${encodeURIComponent(t.name)}`}
                >
                    {t.name}
                </Link>
            ),
        },
        {
            key: "rows",
            header: "Satır",
            numeric: true,
            sortValue: (t) => t.rowCount,
            render: (t) => formatRows(t.rowCount),
        },
        {
            key: "reserved",
            header: "Ayrılmış",
            numeric: true,
            sortValue: (t) => t.reservedKb,
            render: (t) => formatKb(t.reservedKb),
        },
        {
            key: "used",
            header: "Kullanılan",
            numeric: true,
            sortValue: (t) => t.usedKb,
            render: (t) => <span className="muted">{formatKb(t.usedKb)}</span>,
        },
    ];

    if (loading) {
        return <div className="state">Tablolar okunuyor…</div>;
    }
    if (error) {
        return <div className="error">{error}</div>;
    }

    return (
        <>
            <h1>{schema ? `${schema} tabloları` : "Tablolar"}</h1>
            <p className="subtitle">
                {db} · {shown.length} / {rows.length} tablo
            </p>

            <div className="toolbar">
                <input
                    type="search"
                    placeholder="Tablo veya şema ara…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
                <button className="chip" aria-pressed={!schema} onClick={() => navigate(`${base}/tables`)}>
                    tümü
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
            {shown.length === 0 && <div className="state">Eşleşen tablo yok.</div>}
        </>
    );
}
