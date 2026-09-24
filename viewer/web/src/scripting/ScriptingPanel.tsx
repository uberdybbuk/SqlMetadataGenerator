import { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, type ScriptRequest, type ScriptResult } from "../api";
import { useApi } from "../useApi";
import { useFillHeight } from "../useFillHeight";
import { Icon, type IconName } from "../Icon";
import { EMPTY, apply, bulk, idOf, resolve, type ScriptableObject, type Selection, type Target } from "./selection";

const SqlEditor = lazy(() => import("../SqlEditor"));

// Pick objects on the left, say what to do with each on the right, generate.
//
// The left list is FLAT and schema-qualified rather than a tree: a tree made you open two levels
// to reach a table you could already name, and the type chips answer "only show me procedures"
// without hiding anything else behind a twisty.
//
// Being in the set means the object's definition is scripted. For a table there is a second
// question — which rows come with it — and that is the only thing the set's rows column asks.

const RENDER_CAP = 300;

// Above this, "all rows" is not something to ask for without thinking; top or query is.
// Mirrors DataScripter.WarnRows.
const WARN_ROWS = 1000;

const ICONS: Record<string, IconName> = {
    dataTypes: "type",
    tableTypes: "type",
    sequences: "sequence",
    tables: "table",
    views: "view",
    functions: "function",
    procedures: "procedure",
    triggers: "trigger",
    synonyms: "synonym",
};

// Singular, because each one labels ONE object in the KIND column. The server's titles are
// plural — right for a section heading, wrong on a row.
const KIND_LABEL: Record<string, string> = {
    dataTypes: "Type",
    tableTypes: "Table type",
    sequences: "Sequence",
    tables: "Table",
    views: "View",
    functions: "Function",
    procedures: "Procedure",
    triggers: "Trigger",
    synonyms: "Synonym",
};

// What comes with a table's definition. "none" is the DEFAULT and has no button of its own:
// neither toggle lit means no rows, which is the safe thing to have asked for by accident, and
// clicking the lit one turns it off again.
type Rows = "none" | "all" | "query";
const ROW_MODES: Rows[] = ["all", "query"];

interface ScriptingPanelProps {
    alias: string;
    db: string;
    // Held by the page: leaving for the overview unmounts this component, and a picker that forgot
    // your set because you glanced at the treemap is one nobody trusts to leave.
    selection: Selection;
    onSelection: (next: Selection) => void;
}

export function ScriptingPanel({ alias, db, selection, onSelection }: ScriptingPanelProps) {
    const inventory = useApi(() => api.scriptable(alias, db), [alias, db]);
    // Row counts, so a table's size is known BEFORE "all rows" is chosen rather than after the
    // download starts. Approximate (sys.partitions), which is the right precision for a warning.
    const stats = useApi(() => api.tables(alias, db), [alias, db]);

    // Ticked on the left but not yet moved. Its own rule set over the same engine, so ticking a
    // filtered page of results is one entry rather than three hundred.
    const [staged, setStaged] = useState<Selection>(EMPTY);

    const [kind, setKind] = useState<string>("");
    const [search, setSearch] = useState("");
    const [focus, setFocus] = useState<number | null>(null);

    const [rowsMode, setRowsMode] = useState<Record<string, Rows>>({});
    const [wheres, setWheres] = useState<Record<string, string>>({});
    // The row cap, per table. Absent means no TOP. It rides with the WHERE rather than being its
    // own row mode: "the first 100" and "the ones matching this" are the same question asked of
    // the same statement, and one of them can be left blank.
    const [tops, setTops] = useState<Record<string, number | null>>({});
    const [counted, setCounted] = useState<Record<string, number>>({});
    const [active, setActive] = useState<string | null>(null);

    const [options, setOptions] = useState({
        upperCaseKeywords: false,
        emitSetOptions: false,
        groupColumns: true,
    });

    const [step, setStep] = useState<1 | 3>(1);
    const [result, setResult] = useState<ScriptResult | null>(null);
    const [busy, setBusy] = useState<"" | "script" | "files">("");
    const [error, setError] = useState<string | null>(null);
    const [checking, setChecking] = useState(false);
    const { frame, height } = useFillHeight(420);
    const list = useRef<HTMLDivElement>(null);

    // A schema is a dependency of the objects inside it, never a choice: the generator creates the
    // ones the set needs at the top of the script.
    const objects = useMemo(
        () => (inventory.data?.objects ?? []).filter((o) => o.kind !== "schemas"),
        [inventory.data],
    );

    const order = useMemo(() => {
        const map = new Map<string, number>();
        (inventory.data?.kinds ?? [])
            .filter((k) => k.kind !== "schemas")
            .forEach((k, i) => map.set(k.kind, i));
        return map;
    }, [inventory.data]);

    // Schema, then the generator's kind order, then name — so the list reads the way the script
    // will, and everything belonging to one schema sits together.
    const sorted = useMemo(
        () =>
            [...objects].sort(
                (a, b) =>
                    a.schema.localeCompare(b.schema) ||
                    (order.get(a.kind) ?? 99) - (order.get(b.kind) ?? 99) ||
                    a.name.localeCompare(b.name),
            ),
        [objects, order],
    );

    const kinds = useMemo(() => {
        const present = new Set(objects.map((o) => o.kind));
        return (inventory.data?.kinds ?? [])
            .filter((k) => k.kind !== "schemas" && present.has(k.kind))
            .map((k) => k.kind);
    }, [objects, inventory.data]);

    const rowCounts = useMemo(() => {
        const map = new Map<string, number>();
        for (const t of stats.data ?? []) {
            map.set(idOf({ kind: "tables", schema: t.schema, name: t.name }), t.rowCount);
        }
        return map;
    }, [stats.data]);

    const inSet = useMemo(() => resolve(objects, selection), [objects, selection]);
    const stagedIds = useMemo(() => resolve(objects, staged), [objects, staged]);

    const needle = search.trim().toLowerCase();
    const visible = useMemo(
        () =>
            sorted.filter(
                (o) =>
                    (!kind || o.kind === kind) &&
                    (!needle ||
                        o.name.toLowerCase().includes(needle) ||
                        o.schema.toLowerCase().includes(needle) ||
                        (o.schema + "." + o.name).toLowerCase().includes(needle)),
            ),
        [sorted, kind, needle],
    );

    const stagedObjects = useMemo(
        () => objects.filter((o) => stagedIds.has(idOf(o)) && !inSet.has(idOf(o))),
        [objects, stagedIds, inSet],
    );

    // The set, in the order it will be scripted.
    const targets = useMemo(
        () =>
            objects
                .filter((o) => inSet.has(idOf(o)))
                .sort(
                    (a, b) =>
                        (order.get(a.kind) ?? 99) - (order.get(b.kind) ?? 99) ||
                        a.schema.localeCompare(b.schema) ||
                        a.name.localeCompare(b.name),
                ),
        [objects, inSet, order],
    );

    const modeOf = useCallback((id: string): Rows => rowsMode[id] ?? "none", [rowsMode]);
    const withData = targets.filter((o) => modeOf(idOf(o)) !== "none").length;

    useEffect(() => {
        if (focus === null || !list.current) {
            return;
        }
        const el = list.current.querySelector(`[data-row="${focus}"]`);
        if (el instanceof HTMLElement) {
            el.scrollIntoView({ block: "nearest" });
        }
    }, [focus]);

    // ---- staging and moving ----
    const toggleStage = useCallback(
        (o: ScriptableObject, force?: boolean) => {
            const target: Target = { scope: "object", kind: o.kind, schema: o.schema, name: o.name };
            const id = idOf(o);
            // A row already in the set is not staged again; clicking its box takes it OUT, which
            // is the second way back that the set's own × gives on the other side.
            if (inSet.has(id)) {
                onSelection(apply(selection, target, false));
                return;
            }
            setStaged((current) => apply(current, target, force ?? !stagedIds.has(id)));
        },
        [inSet, stagedIds, selection, onSelection],
    );

    const move = useCallback(() => {
        if (stagedObjects.length === 0) {
            return;
        }
        onSelection(bulk(objects, inSet, stagedObjects, "select"));
        setStaged(EMPTY);
        setActive(idOf(stagedObjects[0]));
    }, [stagedObjects, objects, inSet, onSelection]);

    // Read through refs so these keep the same identity for the life of the panel. A memoised row
    // is only worth having if its props stop changing, and a handler that closes over `selection`
    // changes on every click.
    const selectionRef = useRef(selection);
    selectionRef.current = selection;
    const onSelectionRef = useRef(onSelection);
    onSelectionRef.current = onSelection;

    const remove = useCallback((o: ScriptableObject) => {
        onSelectionRef.current(
            apply(selectionRef.current, { scope: "object", kind: o.kind, schema: o.schema, name: o.name }, false),
        );
        setActive((current) => (current === idOf(o) ? null : current));
    }, []);

    const chooseMode = useCallback((id: string, next: Rows) => {
        setRowsMode((c) => ({ ...c, [id]: next }));
        setActive(id);
    }, []);

    const onRowClick = useCallback(
        (o: ScriptableObject, index: number, event: React.MouseEvent) => {
            if (event.shiftKey && focus !== null && visible[focus]) {
                const [from, to] = [focus, index].sort((a, b) => a - b);
                // The range adopts the anchor's state: shift from a ticked row extends the tick.
                const on = stagedIds.has(idOf(visible[focus]));
                setStaged((current) =>
                    visible
                        .slice(from, to + 1)
                        .filter((r) => !inSet.has(idOf(r)))
                        .reduce(
                            (sel, r) =>
                                apply(sel, { scope: "object", kind: r.kind, schema: r.schema, name: r.name }, on),
                            current,
                        ),
                );
                return;
            }
            setFocus(index);
            toggleStage(o);
        },
        [focus, visible, stagedIds, inSet, toggleStage],
    );

    const onKeyDown = useCallback(
        (event: React.KeyboardEvent) => {
            if (visible.length === 0) {
                return;
            }
            const at = focus ?? 0;
            const go = (to: number) => {
                event.preventDefault();
                setFocus(Math.max(0, Math.min(visible.length - 1, to)));
            };
            switch (event.key) {
                case "ArrowDown":
                    return go(focus === null ? 0 : at + 1);
                case "ArrowUp":
                    return go(focus === null ? 0 : at - 1);
                case "Home":
                    return go(0);
                case "End":
                    return go(visible.length - 1);
                case "PageDown":
                    return go(at + 12);
                case "PageUp":
                    return go(at - 12);
                case " ":
                case "Enter":
                    event.preventDefault();
                    return toggleStage(visible[at]);
                default:
                    return;
            }
        },
        [visible, focus, toggleStage],
    );

    // ---- the row being configured ----
    const activeObject = useMemo(() => targets.find((o) => idOf(o) === active) ?? null, [targets, active]);
    const wantsColumns = activeObject !== null && modeOf(active ?? "") === "query";
    // Fetched for the row being configured and no other: the statement head has to name the real
    // columns, and reading every selected table's shape up front would cost a round trip per row
    // for a list most people never open.
    const detail = useApi(
        () =>
            api.table(alias, db, activeObject?.schema ?? "", activeObject?.name ?? ""),
        [alias, db, activeObject?.schema, activeObject?.name],
        wantsColumns,
    );

    const activeWhere = active ? (wheres[active] ?? "") : "";
    const activeTop = active ? (tops[active] ?? null) : null;

    const validate = async () => {
        if (!activeObject || !active) {
            return;
        }
        setChecking(true);
        setError(null);
        try {
            const answer = await api.countRows(alias, db, activeObject.schema, activeObject.name, activeWhere.trim());
            setCounted((current) => ({ ...current, [active]: answer.rows }));
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setChecking(false);
        }
    };

    // Tables asked to bring every row, where every row is a lot. top and query both say the person
    // thought about it; "all" on a fact table usually means nobody did.
    const unbounded = useMemo(
        () =>
            targets.filter(
                (o) => modeOf(idOf(o)) === "all" && (rowCounts.get(idOf(o)) ?? 0) > WARN_ROWS,
            ),
        [targets, modeOf, rowCounts],
    );

    const request = (): ScriptRequest => ({
        objects: targets.map((o) => ({ kind: o.kind, schema: o.schema, name: o.name })),
        data: targets
            .filter((o) => o.kind === "tables" && modeOf(idOf(o)) !== "none")
            .map((o) => {
                const id = idOf(o);
                const mode = modeOf(id);
                return {
                    schema: o.schema,
                    name: o.name,
                    where: mode === "query" ? (wheres[id] ?? "").trim() || undefined : undefined,
                    top: mode === "query" ? (tops[id] ?? undefined) : undefined,
                };
            }),
        ...options,
    });

    const generate = async () => {
        setBusy("script");
        setError(null);
        try {
            setResult(await api.script(alias, db, request()));
            setStep(3);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setResult(null);
        } finally {
            setBusy("");
        }
    };

    const download = async () => {
        setBusy("files");
        setError(null);
        try {
            const { blob, headers } = await api.scriptFiles(alias, db, request());
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            // The server chooses the format (7-Zip where the host has it, zip otherwise) and says
            // so in Content-Disposition. Naming it here would put ".zip" on a .7z.
            link.download = filenameFrom(headers) ?? `${db}-scripts.zip`;
            link.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy("");
        }
    };

    if (inventory.loading) {
        return <div className="state">Reading the object list…</div>;
    }
    if (inventory.error) {
        return <div className="error">{inventory.error}</div>;
    }

    const blocked = targets.length === 0 || unbounded.length > 0;

    return (
        <div className="scripting" ref={frame} style={height ? { height } : undefined}>
            <div className="qtoolbar">
                {/* Not a wizard: 1 and 2 are the two panes below, side by side. The stepper says
                    where you are in the job, and step 3 is the only one that swaps the view. */}
                <span className="steps">
                    <button className="step" aria-current={step === 1} onClick={() => setStep(1)}>
                        <b>1</b> Select
                    </button>
                    <span className="stepsep">›</span>
                    <button className="step" aria-current={step === 1} onClick={() => setStep(1)}>
                        <b>2</b> Configure data
                    </button>
                    <span className="stepsep">›</span>
                    <button className="step" aria-current={step === 3} disabled={!result} onClick={() => setStep(3)}>
                        <b>3</b> Script
                    </button>
                </span>
                <span className="grow" />
                <label className="opt">
                    <input
                        type="checkbox"
                        checked={options.upperCaseKeywords}
                        onChange={(e) => setOptions({ ...options, upperCaseKeywords: e.target.checked })}
                    />
                    UPPERCASE keywords
                </label>
                <label className="opt">
                    <input
                        type="checkbox"
                        checked={options.emitSetOptions}
                        onChange={(e) => setOptions({ ...options, emitSetOptions: e.target.checked })}
                    />
                    SET options
                </label>
                <label className="opt">
                    <input
                        type="checkbox"
                        checked={options.groupColumns}
                        onChange={(e) => setOptions({ ...options, groupColumns: e.target.checked })}
                    />
                    group columns
                </label>
                <span className="tool-sep" />
                <button className="tool" onClick={download} disabled={blocked || busy !== ""}>
                    {busy === "files" ? "Packing…" : "Download as files"}
                </button>
                <button className="tool run" onClick={generate} disabled={blocked || busy !== ""}>
                    <Icon name="play" size={14} />
                    {busy === "script" ? "Scripting…" : "Generate"}
                </button>
            </div>

            {error && <div className="error">{error}</div>}
            {unbounded.length > 0 && (
                <div className="warn-note">
                    {unbounded.length === 1 ? "This table has" : "These tables have"} more than{" "}
                    {WARN_ROWS.toLocaleString("en-US")} rows, so <b>all</b> is probably not what you want:{" "}
                    {unbounded.map((o) => o.schema + "." + o.name).join(", ")}. Use <b>top</b> or <b>query</b> instead.
                </div>
            )}

            {step === 3 && result ? (
                <>
                    {result.missing.length > 0 && (
                        <div className="warn-note">
                            {result.missing.length} asked for but no longer in the catalog: {result.missing.join(", ")}
                        </div>
                    )}
                    {result.cycleTables.length > 0 && (
                        <div className="warn-note">
                            The chosen tables reference each other in a cycle, so no insert order satisfies
                            them. The script disables their constraints for the load and re-validates at the end.
                        </div>
                    )}
                    <div className="script-out">
                        <Suspense fallback={<div className="editor-placeholder" />}>
                            <SqlEditor value={result.sql} valueKey="generated" />
                        </Suspense>
                    </div>
                    <div className="status">
                        <span>{result.scripted} scripted</span>
                        <span className="grow" />
                        <span>{result.sql.split("\n").length.toLocaleString("en-US")} lines</span>
                    </div>
                </>
            ) : (
                <>
                    <div className="shuttle">
                        {/* ---- 1. choose ---- */}
                        <div className="spane source">
                            <div className="pane-head">
                                <div className="searchrow">
                                    <input
                                        type="search"
                                        className="search"
                                        placeholder="Search…"
                                        value={search}
                                        onChange={(e) => setSearch(e.target.value)}
                                    />
                                    <span className="ratio">
                                        {visible.length} / {objects.length}
                                    </span>
                                </div>
                                <div className="kinds">
                                    <button className="chip" aria-pressed={kind === ""} onClick={() => setKind("")}>
                                        All
                                    </button>
                                    {kinds.map((k) => (
                                        <button
                                            key={k}
                                            className="chip"
                                            aria-pressed={kind === k}
                                            onClick={() => setKind(kind === k ? "" : k)}
                                        >
                                            {KIND_LABEL[k] ?? k}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="picker-rows" role="listbox" tabIndex={0} ref={list} onKeyDown={onKeyDown}>
                                {visible.slice(0, RENDER_CAP).map((o, index) => {
                                    const id = idOf(o);
                                    const chosen = inSet.has(id);
                                    const isStaged = stagedIds.has(id) && !chosen;
                                    const count = rowCounts.get(id);
                                    return (
                                        <div
                                            key={id}
                                            className={
                                                "orow" + (chosen ? " chosen" : "") + (focus === index ? " focus" : "")
                                            }
                                            data-row={index}
                                            onClick={(e) => onRowClick(o, index, e)}
                                        >
                                            <span
                                                role="checkbox"
                                                aria-checked={chosen || isStaged}
                                                aria-label={`Select ${o.schema}.${o.name}`}
                                                className={chosen ? "tri in" : "tri"}
                                                title={chosen ? "In the script set — click to take it out" : undefined}
                                            />
                                            <span className="pname mono">
                                                {o.schema}.{o.name}
                                            </span>
                                            <span className="grow" />
                                            <span className="kindcol">{KIND_LABEL[o.kind] ?? o.kind}</span>
                                            <span className="rowcol">
                                                {count !== undefined && count > 0 ? count.toLocaleString("en-US") : ""}
                                            </span>
                                        </div>
                                    );
                                })}
                                {visible.length > RENDER_CAP && (
                                    <div className="state">
                                        Showing the first {RENDER_CAP} of {visible.length}. The buttons below act on all
                                        of them.
                                    </div>
                                )}
                                {visible.length === 0 && <div className="state">Nothing matches.</div>}
                            </div>

                            <div className="picker-foot">
                                <button
                                    className="tool run move"
                                    disabled={stagedObjects.length === 0}
                                    onClick={move}
                                    title="Move everything ticked into the script set"
                                >
                                    Move {stagedObjects.length > 0 ? stagedObjects.length : ""} »
                                </button>
                                <span className="grow" />
                                <button
                                    className="tool"
                                    disabled={visible.length === 0}
                                    onClick={() => setStaged(bulk(objects, stagedIds, visible, "select"))}
                                >
                                    All {visible.length}
                                </button>
                                <button className="tool" disabled={stagedObjects.length === 0} onClick={() => setStaged(EMPTY)}>
                                    None
                                </button>
                                <button
                                    className="tool"
                                    disabled={visible.length === 0}
                                    onClick={() => setStaged(bulk(objects, stagedIds, visible, "invert"))}
                                >
                                    Invert
                                </button>
                            </div>
                        </div>

                        {/* ---- 2. configure ---- */}
                        <div className="spane target">
                            <div className="pane-head row">
                                <b>Script set</b>
                                <span className="pcount">{targets.length}</span>
                                <span className="grow" />
                                <span className="muted">
                                    {targets.length - withData} ddl · {withData} data
                                </span>
                                <button
                                    className="tool"
                                    disabled={targets.length === 0}
                                    onClick={() => {
                                        onSelection(EMPTY);
                                        setActive(null);
                                    }}
                                >
                                    Clear
                                </button>
                            </div>

                            <div className="picker-rows">
                                {targets.length === 0 ? (
                                    <div className="empty">
                                        <b>Nothing chosen yet</b>
                                        <span>Tick objects on the left, then Move.</span>
                                    </div>
                                ) : (
                                    <table className="setgrid">
                                        <thead>
                                            <tr>
                                                <th className="num">#</th>
                                                <th>Object</th>
                                                <th>Kind</th>
                                                <th>Rows</th>
                                                <th className="num">Count</th>
                                                <th />
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {targets.map((o, index) => {
                                                const id = idOf(o);
                                                return (
                                                    <SetRow
                                                        key={id}
                                                        object={o}
                                                        id={id}
                                                        index={index}
                                                        mode={modeOf(id)}
                                                        count={countLabel(modeOf(id), id, counted, rowCounts, tops)}
                                                        active={active === id}
                                                        onPick={setActive}
                                                        onMode={chooseMode}
                                                        onRemove={remove}
                                                    />
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* ---- the query for the row being configured ---- */}
                    <div className="inspector">
                        {activeObject === null || modeOf(active ?? "") !== "query" ? (
                            <div className="state">
                                {activeObject === null
                                    ? "Select a row in the set to configure it."
                                    : `Set ${activeObject.schema}.${activeObject.name} to “query” to choose which rows come with it.`}
                            </div>
                        ) : (
                            <>
                                <div className="pane-head row">
                                    <Icon name={ICONS[activeObject.kind] ?? "table"} size={14} />
                                    <b className="mono">
                                        {activeObject.schema}.{activeObject.name}
                                    </b>
                                    <span className="grow" />
                                    <label className="opt">
                                        <input
                                            type="checkbox"
                                            checked={activeTop !== null}
                                            onChange={(e) =>
                                                setTops((c) => ({ ...c, [active!]: e.target.checked ? 100 : null }))
                                            }
                                        />
                                        top
                                    </label>
                                    {activeTop !== null && (
                                        <input
                                            type="number"
                                            min={1}
                                            className="topn"
                                            value={activeTop}
                                            onChange={(e) =>
                                                setTops((c) => ({
                                                    ...c,
                                                    [active!]: Math.max(1, Number(e.target.value) || 1),
                                                }))
                                            }
                                        />
                                    )}
                                    <span className="tool-sep" />
                                    {active && counted[active] !== undefined && (
                                        <span className="counted">
                                            <b>{counted[active].toLocaleString("en-US")}</b> rows match
                                        </span>
                                    )}
                                    <button className="tool" onClick={validate} disabled={checking}>
                                        {checking ? "Counting…" : "Validate & count"}
                                    </button>
                                </div>
                                {/* The head of the statement, rendered rather than editable.
                                    Monaco has no read-only ranges; the reliable way to make part
                                    of a statement unchangeable is to keep it OUT of the model, so
                                    there is nothing to guard and nothing to defeat. Every column
                                    is always selected — this exports a table's rows, so a partial
                                    column list would produce a script that loads a partial table. */}
                                <div className="stmt mono">
                                    <div>
                                        <span className="kw">select</span>
                                        {activeTop !== null && (
                                            <>
                                                {" "}
                                                <span className="kw">top</span>{" "}
                                                <span className="lit">{activeTop}</span>
                                            </>
                                        )}
                                    </div>
                                    {/* Named, not "*": a star would claim the computed and
                                        rowversion columns come too, and they cannot — the server
                                        assigns them. The list is the server's, from the same rule
                                        the scripter applies. */}
                                    <div className="cols">
                                        {/* Optional-chained: an older server build has no such
                                            field, and a missing column list is a degraded head,
                                            not a crashed panel. */}
                                        {detail.data?.insertableColumns?.join(", ") ??
                                            (detail.loading ? "reading columns…" : "…")}
                                    </div>
                                    <div>
                                        <span className="kw">from</span> {activeObject.schema}.{activeObject.name}
                                    </div>
                                    <div>
                                        <span className="kw">where</span>
                                    </div>
                                </div>
                                <div className="where-editor">
                                    <Suspense fallback={<div className="editor-placeholder" />}>
                                        <SqlEditor
                                            value={activeWhere}
                                            valueKey={active ?? ""}
                                            readOnly={false}
                                            onChange={(next) => setWheres((current) => ({ ...current, [active!]: next }))}
                                        />
                                    </Suspense>
                                </div>
                            </>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

// One row of the script set, memoised.
//
// Without this, clicking any row re-rendered every row — with five thousand objects in the set
// that was 288ms per click, because the whole table is rebuilt whenever the active row changes.
// Its handlers come from the panel as stable callbacks, so the only rows React re-renders are the
// ones whose own props actually changed.
interface SetRowProps {
    object: ScriptableObject;
    id: string;
    index: number;
    mode: Rows;
    count: string;
    active: boolean;
    onPick: (id: string) => void;
    onMode: (id: string, next: Rows) => void;
    onRemove: (o: ScriptableObject) => void;
}

const SetRow = memo(function SetRow({
    object,
    id,
    index,
    mode,
    count,
    active,
    onPick,
    onMode,
    onRemove,
}: SetRowProps) {
    const table = object.kind === "tables";
    return (
        <tr className={active ? "active" : undefined} onClick={() => onPick(id)}>
            <td className="num muted">{index + 1}</td>
            <td className="mono">
                {object.schema}.{object.name}
            </td>
            <td className="muted">{KIND_LABEL[object.kind] ?? object.kind}</td>
            <td>
                {table ? (
                    <span className="seg">
                        {ROW_MODES.map((m) => (
                            <button
                                key={m}
                                className={mode === m ? "on" : undefined}
                                // Clicking the lit one turns it off. "No rows" is a state you can
                                // get back to; it just has no button of its own.
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onMode(id, mode === m ? "none" : m);
                                }}
                            >
                                {m}
                            </button>
                        ))}
                    </span>
                ) : (
                    <span className="muted">—</span>
                )}
            </td>
            <td className="num">{count}</td>
            <td>
                <button
                    className="addbtn back"
                    title="Take out of the script set"
                    onClick={(e) => {
                        e.stopPropagation();
                        onRemove(object);
                    }}
                >
                    ×
                </button>
            </td>
        </tr>
    );
});

// What the COUNT column says. An estimate is marked as one: sys.partitions is not a COUNT(*), and
// a number that looks exact when it is not is worse than no number.
function countLabel(
    mode: Rows,
    id: string,
    counted: Record<string, number>,
    rowCounts: Map<string, number>,
    tops: Record<string, number | null>,
): string {
    const estimate = rowCounts.get(id);
    switch (mode) {
        case "none":
            return "—";
        case "query":
            {
                const cap = tops[id] ?? null;
                const found = counted[id];
                if (found === undefined) {
                    return cap === null ? "?" : cap.toLocaleString("en-US");
                }
                // A cap only ever takes fewer: what will be scripted is whichever is smaller.
                return (cap === null ? found : Math.min(found, cap)).toLocaleString("en-US");
            }
        case "all":
            return estimate !== undefined ? "~" + estimate.toLocaleString("en-US") : "—";
    }
}

// Content-Disposition carries the name the server chose, extension included.
function filenameFrom(headers: Headers): string | null {
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(headers.get("content-disposition") ?? "");
    return match ? decodeURIComponent(match[1]) : null;
}
