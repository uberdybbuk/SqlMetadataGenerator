import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api, type ColumnSummary, type PivotResult } from "../api";
import { useApi } from "../useApi";
import { setSetting, useSetting } from "../settings";
import { FieldPane } from "./FieldPane";
import { FilterBar, type ValueList } from "./FilterBar";
import { EMPTY_LAYOUT, toSpec, type Layout } from "./layout";
import { formatLabel, toMatrix, toTsv, visibleRows, type RowNode } from "./matrix";
import { PivotMatrix } from "./PivotMatrix";

const SqlEditor = lazy(() => import("../SqlEditor"));

// Analysing a table by grouping it, laid out as Excel's pivot table: the matrix and its SQL on
// the left, the field list and the four areas on the right.
//
// The aggregation happens in the DATABASE, not over the rows on screen. The grid holds at most a
// thousand rows because the server caps it there, and a total computed from a capped sample is a
// wrong number presented with complete confidence — the one thing an analysis screen must never
// produce. What travels to the server is a spec; what comes back is the summary and the exact
// statement that produced it.

// How many of a field's values its filter list offers. The most frequent come first.
const VALUE_LIST_LIMIT = 200;

// The panel unmounts whenever another tab is picked, and an analysis that is gone when you come
// back to it is one you cannot work with. So the layout AND its result are kept per table for the
// life of the page. The result is kept rather than recomputed on return: re-running would put a
// whole-table aggregate behind a tab click, which is what the POST endpoint exists to avoid.
interface Ran {
    // The spec the result answers, as sent. Compared with the current one to tell a result that
    // still matches the areas from one the areas have since moved away from.
    key: string;
    layout: Layout;
    result: PivotResult;
}

interface Kept {
    layout: Layout;
    where: string;
    ran: Ran | null;
    error: string | null;
    showSql: boolean;
    collapsed: string[];
}

const kept = new Map<string, Kept>();

export function PivotPanel({ alias, db, schema, name }: { alias: string; db: string; schema: string; name: string }) {
    const shape = useApi(() => api.table(alias, db, schema, name), [alias, db, schema, name]);
    const columns: ColumnSummary[] = useMemo(() => shape.data?.columns ?? [], [shape.data]);
    const limit = useSetting("pivot.limit");
    const autoRun = useSetting("pivot.autoRun");
    const navigate = useNavigate();

    const key = [alias, db, schema, name].join("\u0000");
    const [initial] = useState(() => kept.get(key));
    const [layout, setLayout] = useState<Layout>(initial?.layout ?? EMPTY_LAYOUT);
    const [where, setWhere] = useState(initial?.where ?? "");
    const [ran, setRan] = useState<Ran | null>(initial?.ran ?? null);
    const [error, setError] = useState<string | null>(initial?.error ?? null);
    const [showSql, setShowSql] = useState(initial?.showSql ?? true);
    const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(initial?.collapsed ?? []));
    const [running, setRunning] = useState(false);
    const [preview, setPreview] = useState<{ key: string; sql: string | null; error: string | null } | null>(null);
    const runController = useRef<AbortController | null>(null);

    useEffect(() => {
        kept.set(key, { layout, where, ran, error, showSql, collapsed: [...collapsed] });
    }, [key, layout, where, ran, error, showSql, collapsed]);

    const spec = useMemo(() => toSpec(layout, where, limit), [layout, where, limit]);
    const specKey = JSON.stringify(spec);
    const runBlocker =
        layout.rows.length === 0
            ? "Put at least one field in Rows."
            : layout.values.length === 0
              ? "Put at least one field in Values."
              : null;

    // The answer is also written straight into the kept entry: if the tab was left while the query
    // ran, this panel is gone and its setState goes nowhere, but the result is still waiting there.
    const settle = useCallback(
        (next: { ran?: Ran; error: string | null }) => {
            const entry = kept.get(key);
            if (entry) {
                kept.set(key, { ...entry, ran: next.ran ?? entry.ran, error: next.error, collapsed: next.ran ? [] : entry.collapsed });
            }
            if (next.ran) {
                setRan(next.ran);
                setCollapsed(new Set());
            }
            setError(next.error);
        },
        [key],
    );

    const run = useCallback(async () => {
        if (runBlocker) {
            return;
        }
        runController.current?.abort();
        const controller = new AbortController();
        runController.current = controller;
        const sentKey = specKey;
        const sentLayout = layout;
        setRunning(true);
        setError(null);
        try {
            const result = await api.pivot(alias, db, schema, name, spec, controller.signal);
            settle({ ran: { key: sentKey, layout: sentLayout, result }, error: null });
        } catch (err) {
            if (!controller.signal.aborted) {
                settle({ error: err instanceof Error ? err.message : String(err) });
            }
        } finally {
            if (runController.current === controller) {
                setRunning(false);
            }
        }
    }, [alias, db, schema, name, spec, specKey, layout, runBlocker, settle]);

    // The statement is shown while the areas are still being filled, before anything has run:
    // composing it costs the server nothing, and it is what the matrix will be computed from.
    useEffect(() => {
        if (runBlocker) {
            return;
        }
        const controller = new AbortController();
        const timer = window.setTimeout(() => {
            api.pivotSql(alias, db, schema, name, spec, controller.signal).then(
                (answer) => setPreview({ key: specKey, sql: answer.sql, error: null }),
                (err) => {
                    if (!controller.signal.aborted) {
                        setPreview({ key: specKey, sql: null, error: err instanceof Error ? err.message : String(err) });
                    }
                },
            );
        }, 250);
        return () => {
            window.clearTimeout(timer);
            controller.abort();
        };
    }, [alias, db, schema, name, spec, specKey, runBlocker]);

    // Run on every change: after a pause, so dragging three fields in a row runs once, not three
    // times, and typing a WHERE does not fire a query per keystroke.
    useEffect(() => {
        if (!autoRun || runBlocker || ran?.key === specKey) {
            return;
        }
        const timer = window.setTimeout(() => void run(), 700);
        return () => window.clearTimeout(timer);
    }, [autoRun, runBlocker, ran?.key, specKey, run]);

    useEffect(() => () => runController.current?.abort(), []);

    // A field's filter list: the field's values with how often each occurs, most frequent first.
    // It is itself a pivot — one row field, a count, no totals — so it is computed the same way and
    // goes through the same checks. Kept per field: the values of a table do not change between
    // two clicks on the same filter.
    const valueLists = useRef(new Map<string, Promise<ValueList>>());
    const loadValues = useCallback(
        (column: string): Promise<ValueList> => {
            const cached = valueLists.current.get(column);
            if (cached) {
                return cached;
            }
            const request = api
                .pivot(alias, db, schema, name, {
                    rows: [{ column }],
                    values: [{ agg: "count" }],
                    totals: false,
                    limit: VALUE_LIST_LIMIT,
                })
                .then((answer) => ({
                    values: answer.rows.map((row) => ({
                        value: row[0] === null ? null : String(row[0]),
                        count: Number(row[1]),
                    })),
                    complete: !answer.capped,
                }));
            request.catch(() => valueLists.current.delete(column));
            valueLists.current.set(column, request);
            return request;
        },
        [alias, db, schema, name],
    );

    const matrix = useMemo(
        () => (ran ? toMatrix(ran.result, ran.layout.rows, ran.layout.columns, ran.layout.values) : null),
        [ran],
    );
    const rows = useMemo(() => (matrix ? visibleRows(matrix.root, collapsed) : []), [matrix, collapsed]);
    const groupKeys = useMemo(() => {
        const keys: string[] = [];
        const walk = (node: RowNode) =>
            node.children.forEach((child) => {
                if (child.children.length > 0) {
                    keys.push(child.key);
                    walk(child);
                }
            });
        if (matrix) {
            walk(matrix.root);
        }
        return keys;
    }, [matrix]);

    const stale = ran !== null && ran.key !== specKey;
    const current = preview?.key === specKey ? preview : null;
    const sqlShown = ran && !stale ? ran.result.sql : (current?.sql ?? null);
    const sqlError = ran && !stale ? null : (current?.error ?? null);

    const copy = async () => {
        if (!matrix) {
            return;
        }
        const many = matrix.measures.length > 1;
        const headers = [
            matrix.rowFields.map((f) => f.column).join(" › "),
            ...matrix.heads.flatMap((head) =>
                matrix.measures.map((measure) => {
                    const place =
                        head.kind === "grand"
                            ? matrix.columnFields.length > 0
                                ? "Total"
                                : ""
                            : head.path.map((v, i) => formatLabel(v, matrix.columnFields[i])).join(" / ") +
                              (head.kind === "subtotal" ? " Total" : "");
                    return [place, many || !place ? measure.name : ""].filter(Boolean).join(" · ");
                }),
            ),
        ];
        await navigator.clipboard.writeText(toTsv(matrix, rows, headers));
    };

    if (shape.loading) {
        return <div className="state">Reading the columns…</div>;
    }
    if (shape.error) {
        return <div className="error">{shape.error}</div>;
    }

    const leafColumns = matrix ? matrix.heads.filter((h) => h.kind === "leaf").length || 1 : 0;

    return (
        <div className="pivot">
            <div className="pivot-main">
                <div className="pfilterline">
                    <FilterBar
                        filters={layout.filters}
                        load={loadValues}
                        onChange={(i, next) =>
                            setLayout({ ...layout, filters: layout.filters.map((f, j) => (j === i ? next : f)) })
                        }
                        onRemove={(i) => setLayout({ ...layout, filters: layout.filters.filter((_, j) => j !== i) })}
                    />
                    <label className="pwhere">
                        <span className="plabel">Where</span>
                        <input
                            className="mono"
                            value={where}
                            placeholder="optional — e.g. CreatedAt >= '2026-01-01'"
                            onChange={(e) => setWhere(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && void run()}
                        />
                    </label>
                </div>

                {error && <div className="error">{error}</div>}

                {!matrix && !error && (
                    <div className="panel-empty">
                        <b>{runBlocker ?? "Press Run to compute the matrix"}</b>
                        Tick a field on the right, or drag it into an area. Every figure is computed by the
                        database over the whole table, not over the rows on screen.
                    </div>
                )}

                {matrix && ran && (
                    <div className={stale ? "pmatrix-box stale" : "pmatrix-box"}>
                        {stale && (
                            <div className="pstale">
                                The areas have changed since this ran.{" "}
                                <button
                                    type="button"
                                    className="link-button"
                                    onClick={() => void run()}
                                    disabled={running || runBlocker !== null}
                                >
                                    Run to update
                                </button>
                            </div>
                        )}
                        <PivotMatrix
                            matrix={matrix}
                            rows={rows}
                            collapsed={collapsed}
                            onToggle={(nodeKey) => {
                                const next = new Set(collapsed);
                                if (next.has(nodeKey)) {
                                    next.delete(nodeKey);
                                } else {
                                    next.add(nodeKey);
                                }
                                setCollapsed(next);
                            }}
                        />
                        {ran.result.capped && (
                            <div className="warn-note pcapped">
                                The server stopped at {ran.result.rows.length.toLocaleString("en-US")}{" "}
                                {matrix.columnFields.length > 0 ? "cells" : "groups"}, so some groups are missing
                                from the matrix. The totals still cover every row. Narrow it down with a filter or
                                the WHERE.
                            </div>
                        )}
                        <div className="pstatus">
                            <span>
                                {matrix.leafRows.toLocaleString("en-US")} row groups × {leafColumns} column
                                {leafColumns === 1 ? "" : "s"} · {matrix.cells.toLocaleString("en-US")} cells from the
                                database
                            </span>
                            <span className="pstatus-tools">
                                {groupKeys.length > 0 && (
                                    <>
                                        <button type="button" className="link-button" onClick={() => setCollapsed(new Set(groupKeys))}>
                                            Collapse all
                                        </button>
                                        <button type="button" className="link-button" onClick={() => setCollapsed(new Set())}>
                                            Expand all
                                        </button>
                                    </>
                                )}
                                <button type="button" className="link-button" onClick={() => void copy()}>
                                    Copy
                                </button>
                                <span>{ran.result.elapsedMs} ms</span>
                            </span>
                        </div>
                    </div>
                )}

                <div className="psql">
                    <div className="psql-bar">
                        <b>SQL</b>
                        {sqlShown && (
                            <span className="tag">
                                {ran && !stale ? `Ran in ${ran.result.elapsedMs} ms` : "Preview · not run yet"}
                            </span>
                        )}
                        <span className="grow" />
                        <button
                            type="button"
                            className="tool"
                            disabled={!sqlShown}
                            onClick={() =>
                                navigate(`/app/${encodeURIComponent(alias)}/${encodeURIComponent(db)}/query`, {
                                    state: { sql: sqlShown },
                                })
                            }
                        >
                            Open in query editor
                        </button>
                        <button type="button" className="tool" onClick={() => setShowSql(!showSql)}>
                            {showSql ? "Hide" : "Show"}
                        </button>
                    </div>
                    {showSql &&
                        (sqlError ? (
                            <div className="error psql-error">{sqlError}</div>
                        ) : sqlShown ? (
                            <div className="psql-editor">
                                <Suspense fallback={<div className="editor-placeholder" />}>
                                    <SqlEditor value={sqlShown} />
                                </Suspense>
                            </div>
                        ) : (
                            <div className="state psql-empty">{runBlocker ?? "Composing the statement…"}</div>
                        ))}
                </div>
            </div>

            <FieldPane
                columns={columns}
                layout={layout}
                onLayout={setLayout}
                running={running}
                runBlocker={runBlocker}
                onRun={() => void run()}
                autoRun={autoRun}
                onAutoRun={(on) => setSetting("pivot.autoRun", on)}
            />
        </div>
    );
}
