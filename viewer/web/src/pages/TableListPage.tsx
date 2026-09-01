import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { api } from "../api";
import { useApi } from "../useApi";
import { formatKb, formatRows } from "../format";

type SortKey = "name" | "rows" | "size";

export function TableListPage() {
    const { alias = "", db = "", schema } = useParams();
    const navigate = useNavigate();
    const { data, error, loading } = useApi(() => api.tables(alias, db), [alias, db]);
    const [search, setSearch] = useState("");
    const [sort, setSort] = useState<SortKey>("size");

    const base = `/app/${encodeURIComponent(alias)}/${encodeURIComponent(db)}`;
    const rows = data ?? [];

    const schemas = useMemo(
        () => [...new Set(rows.map((t) => t.schema))].sort((a, b) => a.localeCompare(b, "tr")),
        [rows],
    );

    const shown = useMemo(() => {
        const needle = search.trim().toLocaleLowerCase("tr");
        const filtered = rows.filter(
            (t) =>
                (!schema || t.schema === schema) &&
                (!needle ||
                    t.name.toLocaleLowerCase("tr").includes(needle) ||
                    t.schema.toLocaleLowerCase("tr").includes(needle)),
        );
        return filtered.sort((a, b) => {
            if (sort === "rows") {
                return b.rowCount - a.rowCount;
            }
            if (sort === "size") {
                return b.reservedKb - a.reservedKb;
            }
            return `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`, "tr");
        });
    }, [rows, schema, search, sort]);

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
                <button
                    className="chip"
                    aria-pressed={!schema}
                    onClick={() => navigate(`${base}/tables`)}
                >
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

            <div className="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>Şema</th>
                            <th>
                                <SortButton label="Tablo" active={sort === "name"} onClick={() => setSort("name")} />
                            </th>
                            <th className="num">
                                <SortButton label="Satır" active={sort === "rows"} onClick={() => setSort("rows")} />
                            </th>
                            <th className="num">
                                <SortButton label="Ayrılmış" active={sort === "size"} onClick={() => setSort("size")} />
                            </th>
                            <th className="num">Kullanılan</th>
                        </tr>
                    </thead>
                    <tbody>
                        {shown.map((t) => (
                            <tr key={`${t.schema}.${t.name}`}>
                                <td className="mono muted">{t.schema}</td>
                                <td>
                                    <Link
                                        className="mono"
                                        to={`${base}/tables/${encodeURIComponent(t.schema)}/${encodeURIComponent(t.name)}`}
                                    >
                                        {t.name}
                                    </Link>
                                </td>
                                <td className="num">{formatRows(t.rowCount)}</td>
                                <td className="num">{formatKb(t.reservedKb)}</td>
                                <td className="num muted">{formatKb(t.usedKb)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {shown.length === 0 && <div className="state">Eşleşen tablo yok.</div>}
        </>
    );
}

function SortButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
    return (
        <button
            onClick={onClick}
            style={{
                background: "none",
                border: "none",
                padding: 0,
                font: "inherit",
                color: active ? "var(--accent)" : "inherit",
                cursor: "pointer",
                textTransform: "inherit",
                letterSpacing: "inherit",
            }}
        >
            {label}
            {active ? " ↓" : ""}
        </button>
    );
}
