import { useState } from "react";
import { useParams } from "react-router-dom";

import { api } from "../api";
import { useApi } from "../useApi";
import { formatType } from "../format";

export function TableDetailPage() {
    const { alias = "", db = "", schema = "", name = "" } = useParams();
    const [tab, setTab] = useState<"columns" | "data">("columns");

    const detail = useApi(() => api.table(alias, db, schema, name), [alias, db, schema, name]);

    return (
        <>
            <h1 className="mono">
                {schema}.{name}
            </h1>
            <p className="subtitle">
                {db} · {alias}
            </p>

            {detail.error && <div className="error">{detail.error}</div>}
            {detail.loading && <div className="state">Okunuyor…</div>}

            {detail.data && (
                <>
                    <div className="toolbar">
                        <button className="chip" aria-pressed={tab === "columns"} onClick={() => setTab("columns")}>
                            kolonlar ({detail.data.columns.length})
                        </button>
                        <button className="chip" aria-pressed={tab === "data"} onClick={() => setTab("data")}>
                            veri (ilk 20)
                        </button>
                    </div>

                    {tab === "columns" && (
                        <div className="table-wrap">
                            <table>
                                <thead>
                                    <tr>
                                        <th>#</th>
                                        <th>Kolon</th>
                                        <th>Tip</th>
                                        <th>Null</th>
                                        <th>Anahtar</th>
                                        <th>Varsayılan</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {detail.data.columns.map((c) => (
                                        <tr key={c.columnId}>
                                            <td className="num muted">{c.columnId}</td>
                                            <td className="mono">{c.name}</td>
                                            <td className="mono muted">
                                                {formatType(c.typeName, c.maxLength, c.precision, c.scale)}
                                            </td>
                                            <td className="muted">{c.isNullable ? "null" : "not null"}</td>
                                            <td>
                                                {c.primaryKeyOrdinal !== null && <span className="pill">pk {c.primaryKeyOrdinal}</span>}
                                                {c.isIdentity && <span className="pill"> identity</span>}
                                                {c.isComputed && <span className="pill"> computed</span>}
                                            </td>
                                            <td className="mono muted">{c.defaultDefinition ?? ""}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                    {tab === "data" && <PreviewTab alias={alias} db={db} schema={schema} name={name} />}
                </>
            )}
        </>
    );
}

function PreviewTab({ alias, db, schema, name }: { alias: string; db: string; schema: string; name: string }) {
    const { data, error, loading } = useApi(
        () => api.preview(alias, db, schema, name, 20),
        [alias, db, schema, name],
    );

    if (loading) {
        return <div className="state">İlk 20 satır getiriliyor…</div>;
    }
    if (error) {
        return <div className="error">{error}</div>;
    }
    if (!data || data.rows.length === 0) {
        return <div className="state">Tablo boş.</div>;
    }

    const truncated = data.columns.filter((c) => c.truncated).map((c) => c.name);

    return (
        <>
            <div className="table-wrap">
                <table>
                    <thead>
                        <tr>
                            {data.columns.map((c) => (
                                <th key={c.name}>
                                    {c.name}
                                    <div style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                                        {c.typeName}
                                        {c.truncated && <span className="trunc"> · kısaltıldı</span>}
                                    </div>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {data.rows.map((row, i) => (
                            <tr key={i}>
                                {row.map((value, j) => (
                                    <td key={j} className={typeof value === "number" ? "num" : "mono"}>
                                        {value === null ? (
                                            <span className="muted">NULL</span>
                                        ) : (
                                            String(value).slice(0, 120)
                                        )}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {truncated.length > 0 && (
                <p className="subtitle" style={{ marginTop: 12 }}>
                    Şu kolonlar sunucu tarafında kısaltıldı: <span className="mono">{truncated.join(", ")}</span>.
                    Büyük metin ve binary değerler önizlemede tam taşınmaz.
                </p>
            )}
        </>
    );
}
