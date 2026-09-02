import { Suspense, lazy, useMemo, useState } from "react";
import { useParams } from "react-router-dom";

import { api, type ColumnSummary, type PreviewResult } from "../api";
import { useApi, type AsyncState } from "../useApi";
import { formatType } from "../format";
import { DataTable, type Column } from "../DataTable";
import { Icon } from "../Icon";
import { ResultGrid, type ResultColumn } from "../ResultGrid";

const SqlEditor = lazy(() => import("../SqlEditor"));

export function TableDetailPage() {
    const { alias = "", db = "", schema = "", name = "" } = useParams();
    // Bir tabloya tıklayan kişi önce VERİYİ görmek ister; kolon listesi ikinci sorudur.
    const [tab, setTab] = useState<"columns" | "data">("data");

    // İki istek PARALEL başlar. Önizleme, tablo metadatasına bağlı değil — yalnızca
    // URL'deki adlara. Daha önce önizleme bileşeni metadata geldikten sonra mount
    // olduğu için iki gidiş-dönüş arka arkaya diziliyordu.
    const detail = useApi(() => api.table(alias, db, schema, name), [alias, db, schema, name]);
    const preview = useApi(() => api.preview(alias, db, schema, name, 20), [alias, db, schema, name]);

    const columnInfo = useMemo(
        () => new Map((detail.data?.columns ?? []).map((c) => [c.name, c])),
        [detail.data],
    );

    return (
        <>
            <h1 className="mono with-icon">
                <Icon name="table" size={22} />
                {schema}.{name}
            </h1>
            <p className="subtitle">
                <span className="mono">{db}</span> database · <span className="mono">{alias}</span> server
            </p>

            {/* Sekmeler hiçbir isteği beklemez: iskelet hemen görünür, içerik dolar. */}
            <div className="toolbar">
                <button className="chip" aria-pressed={tab === "data"} onClick={() => setTab("data")}>
                    data (first 20)
                </button>
                <button className="chip" aria-pressed={tab === "columns"} onClick={() => setTab("columns")}>
                    columns{detail.data && ` (${detail.data.columns.length})`}
                </button>
            </div>

            {tab === "data" ? (
                <DataTab
                    preview={preview}
                    columnInfo={columnInfo}
                    metadataSql={detail.data?.previewSql}
                />
            ) : (
                <ColumnsTab detail={detail} />
            )}
        </>
    );
}

function DataTab({
    preview,
    columnInfo,
    metadataSql,
}: {
    preview: AsyncState<PreviewResult>;
    columnInfo: Map<string, ColumnSummary>;
    metadataSql?: string;
}) {
    // Başlık kartındaki ek bilgiler tablo metadatasından gelir; geç gelirse kart
    // o zaman zenginleşir, ızgara onu beklemez.
    const columns: ResultColumn[] = (preview.data?.columns ?? []).map((column) => {
        const meta = columnInfo.get(column.name);
        return {
            name: column.name,
            typeName: column.typeName,
            truncated: column.truncated,
            details: meta && (
                <>
                    <span className="muted">
                        {formatType(meta.typeName, meta.maxLength, meta.precision, meta.scale)} ·{" "}
                        {meta.isNullable ? "nullable" : "not null"}
                    </span>
                    {meta.primaryKeyOrdinal !== null && (
                        <span className="muted">primary key ({meta.primaryKeyOrdinal})</span>
                    )}
                    {meta.isIdentity && <span className="muted">identity</span>}
                    {meta.isComputed && <span className="muted">computed</span>}
                    {meta.defaultDefinition && (
                        <span className="mono muted">default {meta.defaultDefinition}</span>
                    )}
                </>
            ),
        };
    });

    return (
        <>
            {/* Editör sorgu sonucunu BEKLEMEZ ve metnini de sonuçtan almaz: sorgu
                metni kolon metadatasının türevi, hangisi önce gelirse o gösterilir.
                Sonuç geldiğinde onun metni geçerlidir (ileride WHERE'i o taşıyacak). */}
            <div className="editor-wrap">
                <Suspense fallback={<div className="editor-placeholder" />}>
                    <SqlEditor value={preview.data?.sql ?? metadataSql ?? ""} />
                </Suspense>
            </div>

            {preview.error ? (
                <div className="error">{preview.error}</div>
            ) : preview.loading ? (
                <div className="result">
                    <div className="state">Running query…</div>
                </div>
            ) : preview.data ? (
                <ResultGrid
                    columns={columns}
                    rows={preview.data.rows}
                    elapsedMs={preview.data.elapsedMs}
                    messages={preview.data.messages}
                    limitNote="limited to 20"
                />
            ) : null}
        </>
    );
}

function ColumnsTab({ detail }: { detail: AsyncState<{ columns: ColumnSummary[] }> }) {
    const columns: Column<ColumnSummary>[] = [
        { key: "id", header: "#", numeric: true, sortValue: (c) => c.columnId, render: (c) => c.columnId, className: "muted" },
        { key: "name", header: "Column", sortValue: (c) => c.name, render: (c) => c.name, className: "mono" },
        {
            key: "type",
            header: "Type",
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
            header: "Key",
            // Birincil anahtar kolonları önce, anahtar sırasına göre.
            sortValue: (c) => c.primaryKeyOrdinal,
            render: (c) => (
                <>
                    {c.primaryKeyOrdinal !== null && (
                        <span className="pill with-icon">
                            <Icon name="key" size={12} />
                            pk {c.primaryKeyOrdinal}
                        </span>
                    )}
                    {c.isIdentity && <span className="pill"> identity</span>}
                    {c.isComputed && <span className="pill"> computed</span>}
                </>
            ),
        },
        {
            key: "default",
            header: "Default",
            sortValue: (c) => c.defaultDefinition,
            render: (c) => <span className="mono muted">{c.defaultDefinition ?? ""}</span>,
        },
    ];

    if (detail.error) {
        return <div className="error">{detail.error}</div>;
    }
    if (!detail.data) {
        return <div className="state">Loading…</div>;
    }
    return (
        <DataTable
            columns={columns}
            rows={detail.data.columns}
            rowKey={(c) => String(c.columnId)}
            initialSort={{ key: "id" }}
        />
    );
}
