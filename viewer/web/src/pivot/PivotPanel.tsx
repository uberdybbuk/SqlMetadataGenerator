import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api, type ColumnSummary, type PivotResult } from "../api";
import { useApi } from "../useApi";
import { setSetting, useSetting } from "../settings";
import { FieldPane } from "./FieldPane";
import { FilterBar, type ValueList } from "./FilterBar";
import { EMPTY_LAYOUT, describeField, measureKey, toSpec, type Layout, type LayoutField } from "./layout";
import { formatLabel, toMatrix, toTsv, visibleRows, type RowNode } from "./matrix";
import { PivotMatrix } from "./PivotMatrix";
import { fitToColumns, recall, remember } from "./remembered";

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
// life of the page. The layout alone also goes to the browser's storage (remembered.ts), so a
// reload brings the areas back, though not the result. The result is kept rather than recomputed on return: re-running would put a
// whole-table aggregate behind a tab click, which is what the POST endpoint exists to avoid.
interface Ran {
    // The spec the result answers, as sent. Compared with the current one to tell a result that
    // still matches the areas from one the areas have since moved away from.
    key: string;
    // The same without the sorts. A complete result is re-ordered on screen at once, so a sort
    // alone does not make it out of date; a capped one is, since the sort decides which groups
    // the server kept.
    unsortedKey: string;
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
    const [initial] = useState<Partial<Kept> | undefined>(() => kept.get(key) ?? recall(key));
    const [storedLayout, setLayout] = useState<Layout>(initial?.layout ?? EMPTY_LAYOUT);
    // Every change goes through setLayout with a copy of this one, so a field dropped here for a
    // missing column is dropped from the state too at the next edit.
    const layout = useMemo(() => fitToColumns(storedLayout, columns), [storedLayout, columns]);
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

    useEffect(() => {
        const empty = where.trim() === "" && JSON.stringify(layout) === JSON.stringify(EMPTY_LAYOUT);
        remember(key, { layout, where, showSql }, empty);
    }, [key, layout, where, showSql]);

    const spec = useMemo(() => toSpec(layout, where, limit), [layout, where, limit]);
    const specKey = JSON.stringify(spec);
    const unsortedKey = JSON.stringify(toSpec(layout, where, limit, false));
    const upToDate = (r: Ran | null) => r !== null && (r.result.capped ? r.key === specKey : r.unsortedKey === unsortedKey);
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
        const sentUnsorted = unsortedKey;
        const sentLayout = layout;
        setRunning(true);
        setError(null);
        try {
            const result = await api.pivot(alias, db, schema, name, spec, controller.signal);
            settle({ ran: { key: sentKey, unsortedKey: sentUnsorted, layout: sentLayout, result }, error: null });
        } catch (err) {
            if (!controller.signal.aborted) {
                settle({ error: err instanceof Error ? err.message : String(err) });
            }
        } finally {
            if (runController.current === controller) {
                setRunning(false);
            }
        }
    }, [alias, db, schema, name, spec, specKey, unsortedKey, layout, runBlocker, settle]);

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
        if (!autoRun || runBlocker || upToDate(ran)) {
            return;
        }
        const timer = window.setTimeout(() => void run(), 700);
        return () => window.clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRun, runBlocker, ran, specKey, unsortedKey, run]);

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

    // The result's fields with the CURRENT sorts, so picking a sort re-orders the matrix at once
    // instead of waiting for a run. A field that has moved since keeps the sort it ran with.
    const matrix = useMemo(() => {
        if (!ran) {
            return null;
        }
        const resorted = (ranFields: LayoutField[], now: LayoutField[]) =>
            ranFields.map((f, i) =>
                now[i]?.column === f.column && now[i]?.grain === f.grain ? { ...f, sortBy: now[i].sortBy, sortDesc: now[i].sortDesc } : f,
            );
        return toMatrix(ran.result, resorted(ran.layout.rows, layout.rows), resorted(ran.layout.columns, layout.columns), ran.layout.values);
    }, [ran, layout.rows, layout.columns]);
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

    const stale = ran !== null && !upToDate(ran);

    // Clicking a measure's header sorts every row field by it: largest first, then smallest
    // first, then back to the labels. What the header shows is the innermost field's sort.
    const innermost = layout.rows[layout.rows.length - 1];
    const headerSort = (measure: number) => {
        const value = ran?.layout.values[measure];
        if (!value || !layout.values.some((v) => measureKey(v) === measureKey(value))) {
            return;
        }
        const key = measureKey(value);
        const next: Pick<LayoutField, "sortBy" | "sortDesc"> =
            innermost?.sortBy !== key
                ? { sortBy: key, sortDesc: true }
                : innermost.sortDesc
                  ? { sortBy: key, sortDesc: undefined }
                  : { sortBy: undefined, sortDesc: undefined };
        setLayout({ ...layout, rows: layout.rows.map((f) => ({ ...f, ...next })) });
    };
    const sortedBy = (() => {
        const value = ran?.layout.values.findIndex((v) => innermost?.sortBy !== undefined && measureKey(v) === innermost.sortBy);
        return value !== undefined && value >= 0 ? { measure: value, desc: innermost?.sortDesc === true } : null;
    })();

    // The value filters in force, as chips above the matrix: a filter that hides groups should
    // never be something you can only find by opening the right field's menu.
    const valueFilters = (["rows", "columns"] as const).flatMap((area) =>
        layout[area].flatMap((field, index) => {
            const text = field.keep ? describeField({ column: field.column, keep: field.keep }, layout.values) : "";
            return text ? [{ area, index, field, text }] : [];
        }),
    );
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
                    {valueFilters.length > 0 && (
                        <div className="pfilterbar">
                            <span className="plabel">Value filter</span>
                            {valueFilters.map(({ area, index, field, text }) => (
                                <span key={`${area}:${index}`} className="pchip-wrap">
                                    <span className="pchip active mono">
                                        {field.column}: {text}
                                    </span>
                                    <button
                                        type="button"
                                        className="pchip-x"
                                        aria-label={`Remove the value filter on ${field.column}`}
                                        onClick={() =>
                                            setLayout({
                                                ...layout,
                                                [area]: layout[area].map((f, j) => (j === index ? { ...f, keep: undefined } : f)),
                                            })
                                        }
                                    >
                                        ×
                                    </button>
                                </span>
                            ))}
                        </div>
                    )}
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
                        {matrix.leafRows === 0 && (
                            <div className="warn-note pcapped">
                                {valueFilters.length > 0
                                    ? "No group passes the value filter. Loosen it, or remove it with its × above."
                                    : "No rows match, so there is nothing to group."}
                            </div>
                        )}
                        <PivotMatrix
                            matrix={matrix}
                            rows={rows}
                            collapsed={collapsed}
                            sortedBy={sortedBy}
                            onSort={headerSort}
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
