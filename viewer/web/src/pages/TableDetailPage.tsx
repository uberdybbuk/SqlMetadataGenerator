import { useState } from "react";
import { useParams } from "react-router-dom";

import { api, type ColumnSummary } from "../api";
import { useApi } from "../useApi";
import { formatType } from "../format";
import { DataTable, type Column } from "../DataTable";

export function TableDetailPage() {
    const { alias = "", db = "", schema = "", name = "" } = useParams();
    const [tab, setTab] = useState<"columns" | "data">("columns");

    const detail = useApi(() => api.table(alias, db, schema, name), [alias, db, schema, name]);

    const columns: Column<ColumnSummary>[] = [
        { key: "id", header: "#", numeric: true, sortValue: (c) => c.columnId, render: (c) => c.columnId, className: "muted" },
        { key: "name", header: "Kolon", sortValue: (c) => c.name, render: (c) => c.name, className: "mono" },
        {
            key: "type",
            header: "Tip",
            sortValue: (c) => formatType(c.typeName, c.maxLength, c.precision, c.scale),
            render: (c) => (
                <span className="mono muted">{formatType(c.typeName, c.maxLength, c.precision, c.scale)}</span>
            ),
        },
        {
            key: "null",
            header: "Null",
            sortValue: (c) => c.isNullable,
            render: (c) => <span className="muted">{c.isNullable ? "null" : "not null"}</span>,
        },
        {
            key: "key",
            header: "Anahtar",
            // Birincil anahtar kolonları önce, anahtar sırasına göre.
            sortValue: (c) => c.primaryKeyOrdinal,
            render: (c) => (
                <>
                    {c.primaryKeyOrdinal !== null && <span className="pill">pk {c.primaryKeyOrdinal}</span>}
                    {c.isIdentity && <span className="pill"> identity</span>}
                    {c.isComputed && <span className="pill"> computed</span>}
                </>
            ),
        },
        {
            key: "default",
            header: "Varsayılan",
            sortValue: (c) => c.defaultDefinition,
            render: (c) => <span className="mono muted">{c.defaultDefinition ?? ""}</span>,
        },
    ];

    return (
        <>
            <h1 className="mono">
                {schema}.{name}
            </h1>
            <p className="subtitle">
                <span className="mono">{db}</span> veritabanı · <span className="mono">{alias}</span> sunucusu
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
                        <DataTable
                            columns={columns}
                            rows={detail.data.columns}
                            rowKey={(c) => String(c.columnId)}
                            initialSort={{ key: "id" }}
                        />
                    )}

                    {tab === "data" && <PreviewTab alias={alias} db={db} schema={schema} name={name} />}
                </>
            )}
        </>
    );
}

// Önizleme satırı: kolonlar çalışma zamanında belirlendiği için dizi olarak gelir.
// Sıralama için satırın kendisini sarmalıyoruz.
interface PreviewRow {
    index: number;
    values: (string | number | boolean | null)[];
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
    const rows: PreviewRow[] = data.rows.map((values, index) => ({ index, values }));

    const columns: Column<PreviewRow>[] = data.columns.map((column, i) => ({
        key: `${i}-${column.name}`,
        numeric: typeof data.rows[0]?.[i] === "number",
        header: (
            <>
                {column.name}
                <div style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                    {column.typeName}
                    {column.truncated && <span className="trunc"> · kısaltıldı</span>}
                </div>
            </>
        ),
        sortValue: (row) => row.values[i],
        render: (row) =>
            row.values[i] === null ? (
                <span className="muted">NULL</span>
            ) : (
                String(row.values[i]).slice(0, 120)
            ),
        className: typeof data.rows[0]?.[i] === "number" ? undefined : "mono",
    }));

    return (
        <>
            <DataTable columns={columns} rows={rows} rowKey={(row) => String(row.index)} />
            {truncated.length > 0 && (
                <p className="subtitle" style={{ marginTop: 12 }}>
                    Şu kolonlar sunucu tarafında kısaltıldı: <span className="mono">{truncated.join(", ")}</span>.
                    Büyük metin ve binary değerler önizlemede tam taşınmaz.
                </p>
            )}
        </>
    );
}
