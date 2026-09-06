import { Suspense, lazy, useState } from "react";
import { useParams } from "react-router-dom";

import { api, type ColumnSummary, type IndexSummary, type PreviewResult, type TableDetail } from "../api";
import { useApi, type AsyncState } from "../useApi";
import { formatType, unwrapDefault } from "../format";
import { DataTable, type Column } from "../DataTable";
import { Icon } from "../Icon";
import { ResultGrid, type ResultColumn } from "../ResultGrid";
import { QueryPane } from "../QueryPane";
import { useQueryRunner, type QueryRunner } from "../useQueryRunner";

const SqlEditor = lazy(() => import("../SqlEditor"));

export function TableDetailPage() {
    const { alias = "", db = "", schema = "", name = "" } = useParams();
    // Whoever clicks a table wants to see the DATA first; the column list is the second question.
    const [tab, setTab] = useState<"data" | "detail" | "script">("data");

    // The two requests start in PARALLEL. The preview does not depend on the table metadata — only
    // on the names in the URL. Previously the preview component mounted after the metadata had
    // arrived, which put the two round trips back to back.
    // The column list is requested ONLY when its tab is opened. The data tab does not wait on it
    // — the preview carries its own column metadata — and a second concurrent query was slowing
    // the main query down.
    const runner = useQueryRunner(alias, db);
    const [detailWanted, setDetailWanted] = useState(false);
    // The script costs a whole-database metadata read, so it waits for a deliberate click and,
    // once fetched, is not asked for again while the page stays open.
    const [scriptWanted, setScriptWanted] = useState(false);
    const detail = useApi(
        () => api.table(alias, db, schema, name),
        [alias, db, schema, name],
        detailWanted,
    );
    const script = useApi(
        () => api.tableScript(alias, db, schema, name),
        [alias, db, schema, name],
        scriptWanted,
    );
    const preview = useApi(
        (signal) => api.preview(alias, db, schema, name, 20, signal),
        [alias, db, schema, name],
    );
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
                <button
                    className="chip"
                    aria-pressed={tab === "script"}
                    onClick={() => {
                        setScriptWanted(true);
                        setTab("script");
                    }}
                >
                    script
                </button>
            </div>

            {tab === "data" && (
                <DataTab
                    preview={preview}
                    runner={runner}
                    sql={previewSql.data?.sql ?? preview.data?.sql ?? ""}
                />
            )}
            {tab === "detail" && <DetailTab detail={detail} />}
            {tab === "script" && <ScriptTab script={script} />}
        </>
    );
}

function DataTab({
    preview,
    runner,
    sql,
}: {
    preview: AsyncState<PreviewResult>;
    runner: QueryRunner;
    sql: string;
}) {
    // Until something is run here the grid shows the preview the page opened with; afterwards it
    // shows the answer to the query on screen. Two shapes, one grid: the preview knows its columns
    // from the catalog, a free-form query only from the reader.
    const previewColumns: ResultColumn[] = (preview.data?.columns ?? []).map((column) => {
        const meta = column.column;
        return {
            name: column.name,
            // The RAW type name, not the formatted one: formatCell matches it against a set of
            // exact names to decide how a value is rendered, and "datetime2(7)" misses "datetime2"
            // — which quietly brought the ISO "T" back into every timestamp.
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
                        <span className="mono muted">default {unwrapDefault(meta.defaultDefinition)}</span>
                    )}
                </>
            ),
        };
    });

    const queryColumns: ResultColumn[] = (runner.data?.columns ?? []).map((column) => ({
        name: column.name,
        typeName: column.typeName,
        truncated: false,
        details: <span className="mono muted">{column.typeName}</span>,
    }));

    const active = runner.ran
        ? {
              loading: runner.loading,
              error: runner.error,
              columns: queryColumns,
              rows: runner.data?.rows ?? [],
              elapsedMs: runner.data?.elapsedMs ?? 0,
              messages: runner.data?.messages ?? [],
              note: runner.data?.capped ? "stopped at 1000 rows" : undefined,
              has: runner.data !== null,
          }
        : {
              loading: preview.loading,
              error: preview.error,
              columns: previewColumns,
              rows: preview.data?.rows ?? [],
              elapsedMs: preview.data?.elapsedMs ?? 0,
              messages: preview.data?.messages ?? [],
              note: "limited to 20",
              has: preview.data !== null,
          };

    const result = active.error ? (
        <div className="error">{active.error}</div>
    ) : active.loading ? (
        <div className="result">
            <div className="state">Running query…</div>
        </div>
    ) : active.has ? (
        <ResultGrid
            columns={active.columns}
            rows={active.rows}
            elapsedMs={active.elapsedMs}
            messages={active.messages}
            limitNote={active.note}
        />
    ) : (
        <div className="result">
            <div className="state">Cancelled.</div>
        </div>
    );

    return (
        <QueryPane
            sql={sql}
            result={result}
            onExecute={(text) => runner.run(text)}
            onCancel={() => {
                preview.cancel();
                runner.cancel();
            }}
            running={preview.loading || runner.loading}
        />
    );
}

// The CREATE script, in the same editor the preview uses. The frame is drawn before the request
// answers so the tab does not arrive by shoving the page around.
function ScriptTab({ script }: { script: AsyncState<{ sql: string }> }) {
    return (
        <>
            {script.error && <div className="error">{script.error}</div>}
            <div className="badges">
                <span
                    className="badge"
                    title="Produced by the same Scripting layer that writes the .sql files, so this is exactly what the generator would output."
                >
                    {script.loading ? "reading metadata…" : "as the generator would write it"}
                </span>
            </div>
            <div className="editor-wrap tall">
                <Suspense fallback={<div className="editor-placeholder" />}>
                    <SqlEditor value={script.data?.sql ?? ""} />
                </Suspense>
            </div>
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
            info: "Shown without the parentheses SQL Server wraps a default in. The script tab keeps the server's exact text.",
            sortValue: (c) => c.defaultDefinition,
            render: (c) => (
                <span className="mono muted">
                    {c.defaultDefinition ? unwrapDefault(c.defaultDefinition) : ""}
                </span>
            ),
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
                    initialSort={{ key: "kind" }}
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
        // Clustered first — there is at most one and it decides how the rows are physically
        // stored, so it is the one to read before the others.
        sortValue: (i) => `${i.typeDesc === "CLUSTERED" ? "0" : "1"}${i.isPrimaryKey ? "0" : "1"}${i.name}`,
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
