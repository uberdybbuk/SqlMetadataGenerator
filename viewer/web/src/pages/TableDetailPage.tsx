import { Suspense, lazy, useState } from "react";
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
    // Whoever clicks a table wants to see the DATA first; the column list is the second question.
    const [tab, setTab] = useState<"columns" | "data">("data");

    // The two requests start in PARALLEL. The preview does not depend on the table metadata — only
    // on the names in the URL. Previously the preview component mounted after the metadata had
    // arrived, which put the two round trips back to back.
    // The column list is requested ONLY when its tab is opened. The data tab does not wait on it
    // — the preview carries its own column metadata — and a second concurrent query was slowing
    // the main query down.
    const [columnsWanted, setColumnsWanted] = useState(false);
    const detail = useApi(
        () => api.table(alias, db, schema, name),
        [alias, db, schema, name],
        columnsWanted,
    );
    const preview = useApi(() => api.preview(alias, db, schema, name, 20), [alias, db, schema, name]);
    // Fired alongside the preview, not after it. It only reads the catalog, so the editor fills in
    // while the rows are still on their way — on a slow table that is the difference between
    // seeing the query and staring at an empty pane.
    const previewSql = useApi(() => api.previewSql(alias, db, schema, name, 20), [alias, db, schema, name]);

    return (
        <>
            <h1 className="mono with-icon">
                <Icon name="table" size={22} />
                {schema}.{name}
            </h1>
            <p className="subtitle">
                <span className="mono">{db}</span> database · <span className="mono">{alias}</span> server
            </p>

            {/* The tabs wait on no request: the skeleton shows at once and the content fills in. */}
            <div className="toolbar">
                <button className="chip" aria-pressed={tab === "data"} onClick={() => setTab("data")}>
                    data (first 20)
                </button>
                <button
                    className="chip"
                    aria-pressed={tab === "columns"}
                    onClick={() => {
                        setColumnsWanted(true);
                        setTab("columns");
                    }}
                >
                    columns{preview.data && ` (${preview.data.columns.length})`}
                </button>
            </div>

            {tab === "data" ? (
                <DataTab preview={preview} sql={previewSql.data?.sql ?? preview.data?.sql ?? ""} />
            ) : (
                <ColumnsTab detail={detail} />
            )}
        </>
    );
}

function DataTab({ preview, sql }: { preview: AsyncState<PreviewResult>; sql: string }) {
    // The information on the header card arrives with the preview itself; no separate request.
    const columns: ResultColumn[] = (preview.data?.columns ?? []).map((column) => {
        const meta = column.column;
        return {
            name: column.name,
            typeName: column.typeName,
            truncated: column.truncated,
            details: (
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
            {/* The query text comes from its own endpoint, which only reads the catalog, so it is on
                screen while the rows are still being fetched. The preview's copy is the fallback. */}
            <div className="editor-wrap">
                <Suspense fallback={<div className="editor-placeholder" />}>
                    <SqlEditor value={sql} />
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
            // Primary key columns first, in key order.
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
