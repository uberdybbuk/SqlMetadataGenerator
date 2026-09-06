import { Suspense, lazy, useState } from "react";
import { useParams } from "react-router-dom";

import { api, type ColumnSummary, type IndexSummary, type PreviewResult, type TableDetail } from "../api";
import { useApi, type AsyncState } from "../useApi";
import { formatType } from "../format";
import { DataTable, type Column } from "../DataTable";
import { Icon } from "../Icon";
import { ResultGrid, type ResultColumn } from "../ResultGrid";

const SqlEditor = lazy(() => import("../SqlEditor"));

export function TableDetailPage() {
    const { alias = "", db = "", schema = "", name = "" } = useParams();
    // Whoever clicks a table wants to see the DATA first; the column list is the second question.
    const [tab, setTab] = useState<"detail" | "data">("data");

    // The two requests start in PARALLEL. The preview does not depend on the table metadata — only
    // on the names in the URL. Previously the preview component mounted after the metadata had
    // arrived, which put the two round trips back to back.
    // The column list is requested ONLY when its tab is opened. The data tab does not wait on it
    // — the preview carries its own column metadata — and a second concurrent query was slowing
    // the main query down.
    const [detailWanted, setDetailWanted] = useState(false);
    const detail = useApi(
        () => api.table(alias, db, schema, name),
        [alias, db, schema, name],
        detailWanted,
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
                    aria-pressed={tab === "detail"}
                    onClick={() => {
                        setDetailWanted(true);
                        setTab("detail");
                    }}
                >
                    detail
                </button>
            </div>

            {tab === "data" ? (
                <DataTab preview={preview} sql={previewSql.data?.sql ?? preview.data?.sql ?? ""} />
            ) : (
                <DetailTab detail={detail} />
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

// Columns, indexes and the table's own facts. Named "detail" rather than "columns" because the
// same shape will serve views and routines, whose interesting parts are not columns at all.
function DetailTab({ detail }: { detail: AsyncState<TableDetail> }) {
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
        <>
            <div className="badges">
                {detail.data.createDate && (
                    <span className="badge">created {stamp(detail.data.createDate)}</span>
                )}
                {detail.data.modifyDate && (
                    <span className="badge">modified {stamp(detail.data.modifyDate)}</span>
                )}
                {detail.data.owner && (
                    <span
                        className="badge"
                        title="The catalog records an owner, never a creator — SQL Server does not keep who ran the CREATE."
                    >
                        owner {detail.data.owner}
                    </span>
                )}
            </div>

            <h2>Columns</h2>
            <DataTable
                columns={columns}
                rows={detail.data.columns}
                rowKey={(c) => String(c.columnId)}
                initialSort={{ key: "id" }}
                dense
            />

            <h2>
                Indexes{detail.data.indexes.length > 0 && ` (${detail.data.indexes.length})`}
            </h2>
            {detail.data.indexes.length === 0 ? (
                <div className="state">No rowstore index — this table is a heap.</div>
            ) : (
                <DataTable
                    columns={indexColumns}
                    rows={detail.data.indexes}
                    rowKey={(i) => i.name}
                    initialSort={{ key: "name" }}
                    dense
                />
            )}
        </>
    );
}

// Sub-second digits are noise on a badge; seconds answer "when was this last changed".
function stamp(iso: string): string {
    return iso.slice(0, 19).replace("T", " ");
}

const indexColumns: Column<IndexSummary>[] = [
    {
        key: "name",
        header: "Index",
        sortValue: (i) => i.name,
        render: (i) => <span className="mono">{i.name}</span>,
    },
    {
        key: "kind",
        header: "Kind",
        sortValue: (i) => `${i.isPrimaryKey ? "0" : "1"}${i.typeDesc}`,
        render: (i) => (
            <>
                <span className="muted">{i.typeDesc.toLowerCase()}</span>
                {i.isPrimaryKey && (
                    <span className="pill with-icon">
                        <Icon name="key" size={12} />
                        pk
                    </span>
                )}
                {i.isUniqueConstraint && <span className="pill"> unique constraint</span>}
                {!i.isPrimaryKey && !i.isUniqueConstraint && i.isUnique && (
                    <span className="pill"> unique</span>
                )}
            </>
        ),
    },
    {
        key: "keys",
        header: "Key columns",
        info: "In key order. This is the order a query has to match to use the index.",
        sortValue: (i) => i.keyColumns.map((k) => k.name).join(", "),
        render: (i) => (
            <span className="mono">
                {i.keyColumns.map((k) => k.name + (k.descending ? " desc" : "")).join(", ")}
            </span>
        ),
    },
    {
        key: "included",
        header: "Included",
        info: "Carried in the leaf level so a query reading only these columns never touches the table.",
        sortValue: (i) => i.includedColumns.length,
        render: (i) => <span className="mono muted">{i.includedColumns.join(", ")}</span>,
    },
    {
        key: "filter",
        header: "Filter",
        info: "A filtered index only covers rows matching this predicate.",
        sortValue: (i) => i.filter ?? "",
        render: (i) => <span className="mono muted">{i.filter ?? ""}</span>,
    },
];
