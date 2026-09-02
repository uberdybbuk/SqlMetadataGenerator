import { Suspense, lazy, useState } from "react";
import { useParams } from "react-router-dom";

import { api, type ColumnSummary } from "../api";
import { useApi } from "../useApi";
import { formatType } from "../format";
import { DataTable, type Column } from "../DataTable";
import { Icon } from "../Icon";
import { ResultGrid, type ResultColumn } from "../ResultGrid";

// Monaco büyük; yalnızca veri sekmesi açılınca indirilsin.
const SqlEditor = lazy(() => import("../SqlEditor"));

export function TableDetailPage() {
    const { alias = "", db = "", schema = "", name = "" } = useParams();
    // Bir tabloya tıklayan kişi önce VERİYİ görmek ister; kolon listesi
    // ikinci sorudur.
    const [tab, setTab] = useState<"columns" | "data">("data");

    const detail = useApi(() => api.table(alias, db, schema, name), [alias, db, schema, name]);

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

    return (
        <>
            <h1 className="mono with-icon">
                <Icon name="table" size={22} />
                {schema}.{name}
            </h1>
            <p className="subtitle">
                <span className="mono">{db}</span> database · <span className="mono">{alias}</span> server
            </p>

            {detail.error && <div className="error">{detail.error}</div>}
            {detail.loading && <div className="state">Loading…</div>}

            {detail.data && (
                <>
                    <div className="toolbar">
                        <button className="chip" aria-pressed={tab === "columns"} onClick={() => setTab("columns")}>
                            columns ({detail.data.columns.length})
                        </button>
                        <button className="chip" aria-pressed={tab === "data"} onClick={() => setTab("data")}>
                            data (first 20)
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

                    {tab === "data" && (
                        <PreviewTab
                            alias={alias}
                            db={db}
                            schema={schema}
                            name={name}
                            columnInfo={new Map(detail.data.columns.map((c) => [c.name, c]))}
                        />
                    )}
                </>
            )}
        </>
    );
}

function PreviewTab({
    alias,
    db,
    schema,
    name,
    columnInfo,
}: {
    alias: string;
    db: string;
    schema: string;
    name: string;
    columnInfo: Map<string, ColumnSummary>;
}) {
    const { data, error, loading } = useApi(
        () => api.preview(alias, db, schema, name, 20),
        [alias, db, schema, name],
    );

    if (loading) {
        return <div className="state">Fetching first 20 rows…</div>;
    }
    if (error) {
        return <div className="error">{error}</div>;
    }
    if (!data) {
        return null;
    }

    // Başlık kartındaki ek bilgiler tablo metadatasından gelir; ResultGrid'in
    // kendisi tablo kavramını bilmez, yalnızca hazır içeriği gösterir.
    const columns: ResultColumn[] = data.columns.map((column) => {
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
            <div className="editor-wrap">
                <Suspense fallback={<div className="state">Loading editor…</div>}>
                    <SqlEditor value={data.sql} />
                </Suspense>
            </div>

            <ResultGrid
                columns={columns}
                rows={data.rows}
                elapsedMs={data.elapsedMs}
                messages={data.messages}
                limitNote="limited to 20"
            />
        </>
    );
}
