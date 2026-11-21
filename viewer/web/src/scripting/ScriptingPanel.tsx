import { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, type ScriptJobResult, type ScriptJobStatus, type ScriptRequest, type TableStats } from "../api";
import { useApi, type AsyncState } from "../useApi";
import { useFillHeight } from "../useFillHeight";
import { Icon, type IconName } from "../Icon";
import { useSetting } from "../settings";
import { EMPTY, apply, bulk, idOf, resolve, type ScriptableObject, type Selection, type Target } from "./selection";
import { matchPastedList, type PasteOutcome } from "./pasteList";
import { JobDone, JobProgress } from "./ScriptJob";

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

// What the script carries. "data" leaves every definition out and keeps only the rows: the
// target already has the tables, and what is wanted is their contents.
type Output = "both" | "data";
const OUTPUTS: [Output, string][] = [
    ["both", "DDL + data"],
    ["data", "data only"],
];

// A job that finishes within this shows no progress at all: its script simply appears. Even a
// selection of two tables pays for the catalog reads, which take two to three seconds against a
// remote server, and a panel flashing up for that and away again is noise.
const PROGRESS_AFTER_MS = 4000;
const POLL_MS = 400;

// The last finished script. sql is null when it was over the editor's limit and went to the
// downloads instead.
interface Shown {
    jobId: string;
    sql: string | null;
    info: ScriptJobResult;
    status: ScriptJobStatus;
    // The server deletes the file after the kept time, and Download again stops working then.
    keptUntil: number;
    expired: boolean;
}

interface ScriptingPanelProps {
    alias: string;
    db: string;
    // Held by the page: leaving for the overview unmounts this component, and a picker that forgot
    // your set because you glanced at the treemap is one nobody trusts to leave.
    selection: Selection;
    onSelection: (next: Selection) => void;
    // Row counts, so a table's size is known BEFORE "all rows" is chosen rather than after the
    // download starts. Approximate (sys.partitions), which is the right precision for a warning.
    // The page's own read, handed down: on a large database it is a slow query, and opening
    // scripting while the overview's is still running must not send a second one.
    stats: AsyncState<TableStats[]>;
}

export function ScriptingPanel({ alias, db, selection, onSelection, stats }: ScriptingPanelProps) {
    const inventory = useApi(() => api.scriptable(alias, db), [alias, db]);

    // Ticked on the left but not yet moved. Its own rule set over the same engine, so ticking a
    // filtered page of results is one entry rather than three hundred.
    const [staged, setStaged] = useState<Selection>(EMPTY);

    const [kind, setKind] = useState<string>("");
    const [search, setSearch] = useState("");
    const [focus, setFocus] = useState<number | null>(null);

    // The set's own filter and ticks. Plain ids rather than a rule set: they only ever feed one
    // Remove, which rebuilds the selection's rules from what is left.
    const [chosenKind, setChosenKind] = useState<string>("");
    const [chosenSearch, setChosenSearch] = useState("");
    const [ticked, setTicked] = useState<Set<string>>(() => new Set());
    const [tickAnchor, setTickAnchor] = useState<number | null>(null);

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
    const [output, setOutput] = useState<Output>("both");

    // The pasted list. Open is the box being shown, outcome is what the last Tick found.
    const [pasteOpen, setPasteOpen] = useState(false);
    const [pasteText, setPasteText] = useState("");
    const [pasteOutcome, setPasteOutcome] = useState<PasteOutcome | null>(null);

    const [step, setStep] = useState<1 | 3>(1);
    const [result, setResult] = useState<Shown | null>(null);
    const [busy, setBusy] = useState<"" | "script" | "files">("");
    // The job being watched, and whether it has run long enough to show where it is.
    const [running, setRunning] = useState<ScriptJobStatus | null>(null);
    const [showProgress, setShowProgress] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    // The id of the job this panel is waiting for. Cleared by Cancel and on unmount, which is how
    // the polling loop learns to stop.
    const jobRef = useRef<string | null>(null);
    const editorLimitMb = useSetting("scripting.editorLimitMb");
    const keepMinutes = useSetting("scripting.keepMinutes");
    const [error, setError] = useState<string | null>(null);
    const [checking, setChecking] = useState(false);
    const { frame, height } = useFillHeight(420);
    // Above this, "all rows" is not something to ask for without thinking; top or query is.
    // The default matches DataScripter.WarnRows.
    const warnRows = useSetting("scripting.warnRows");
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

    // null is a table whose size is UNKNOWN (PostgreSQL, never analysed); absent is a table the
    // stats read has not produced yet. The two are kept apart because the size warning below
    // must treat unknown as big and must not fire while the counts are still loading.
    const rowCounts = useMemo(() => {
        const map = new Map<string, number | null>();
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
            sorted.filter((o) => (!kind || o.kind === kind) && matches(o, needle)),
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
    const dataOnly = output === "data";

    // Ticks what the pasted list names, on top of whatever is ticked already. An object already
    // in the set counts as found and stays where it is.
    const tickPasted = () => {
        const outcome = matchPastedList(pasteText, objects);
        const fresh = outcome.found.filter((o) => !inSet.has(idOf(o)));
        setStaged(bulk(objects, stagedIds, fresh, "select"));
        setPasteOutcome(outcome);
        setPasteOpen(false);
    };

    const chosenKinds = useMemo(() => {
        const present = new Set(targets.map((o) => o.kind));
        return kinds.filter((k) => present.has(k));
    }, [targets, kinds]);

    const chosenNeedle = chosenSearch.trim().toLowerCase();
    const chosenVisible = useMemo(
        () => targets.filter((o) => (!chosenKind || o.kind === chosenKind) && matches(o, chosenNeedle)),
        [targets, chosenKind, chosenNeedle],
    );

    // Ticks on objects that have since left the set count for nothing.
    const tickedObjects = useMemo(() => targets.filter((o) => ticked.has(idOf(o))), [targets, ticked]);

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

    // Shift extends from the last box clicked, taking that box's state, as on the left. Its
    // identity changes with every click, which re-renders the shown rows. They are capped at
    // RENDER_CAP, so that is cheap.
    const tick = useCallback((index: number, shift: boolean) => {
        const rows = chosenVisible;
        const anchor = tickAnchor;
        setTicked((current) => {
            const next = new Set(current);
            if (shift && anchor !== null && rows[anchor]) {
                const on = current.has(idOf(rows[anchor]));
                const [from, to] = [anchor, index].sort((a, b) => a - b);
                for (const o of rows.slice(from, to + 1)) {
                    if (on) {
                        next.add(idOf(o));
                    } else {
                        next.delete(idOf(o));
                    }
                }
                return next;
            }
            const id = idOf(rows[index]);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
        if (!shift) {
            setTickAnchor(index);
        }
    }, [chosenVisible, tickAnchor]);

    // A shift range is counted in rows of the filtered list, so a new filter starts a new range.
    const filterChosen = (next: { search?: string; kind?: string }) => {
        if (next.search !== undefined) {
            setChosenSearch(next.search);
        }
        if (next.kind !== undefined) {
            setChosenKind(next.kind);
        }
        setTickAnchor(null);
    };

    const removeTicked = useCallback(() => {
        if (tickedObjects.length === 0) {
            return;
        }
        const gone = new Set(tickedObjects.map(idOf));
        onSelection(bulk(objects, inSet, tickedObjects, "deselect"));
        setTicked(new Set());
        setTickAnchor(null);
        setActive((current) => (current !== null && gone.has(current) ? null : current));
    }, [tickedObjects, objects, inSet, onSelection]);

    const tickBulk = (action: "select" | "invert") => {
        setTicked((current) => {
            const next = new Set(current);
            for (const o of chosenVisible) {
                const id = idOf(o);
                if (action === "select" || !next.has(id)) {
                    next.add(id);
                } else {
                    next.delete(id);
                }
            }
            return next;
        });
    };

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
            targets.filter((o) => {
                const id = idOf(o);
                if (modeOf(id) !== "all") {
                    return false;
                }
                const estimate = rowCounts.get(id);
                // Unknown counts as too big. Waving a table through because nobody measured it is
                // the one failure that silently produces the enormous script this warning exists for.
                return estimate === null || (estimate !== undefined && estimate > warnRows);
            }),
        [targets, modeOf, rowCounts, warnRows],
    );

    const request = (): ScriptRequest => ({
        // Data only sends no definitions at all. The server takes rows for a table that is not
        // among the objects, which is exactly this case.
        objects: dataOnly ? [] : targets.map((o) => ({ kind: o.kind, schema: o.schema, name: o.name })),
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

    // Starts a job and follows it to the end. Short jobs never show the progress panel: it appears
    // only once the job has run past PROGRESS_AFTER_MS.
    const run = async (kind: "script" | "files") => {
        setBusy(kind);
        setError(null);
        setCancelling(false);
        const started = Date.now();
        let id: string | null = null;
        try {
            id = (await api.startScriptJob(alias, db, { ...request(), output: kind, keepMinutes })).id;
            jobRef.current = id;

            let status: ScriptJobStatus;
            for (;;) {
                status = await api.scriptJob(id);
                if (jobRef.current !== id) {
                    return;
                }
                setRunning(status);
                if (status.state !== "running") {
                    break;
                }
                if (Date.now() - started > PROGRESS_AFTER_MS) {
                    setShowProgress(true);
                }
                await wait(POLL_MS);
                if (jobRef.current !== id) {
                    return;
                }
            }

            if (status.state === "failed") {
                setError(status.error ?? "Script generation failed.");
                return;
            }
            if (status.state !== "done" || !status.result) {
                return;
            }

            const info = status.result;
            if (kind === "files") {
                startDownload(api.scriptJobDownloadUrl(id), info.fileName);
                return;
            }

            const keptUntil = Date.now() + keepMinutes * 60_000;
            if (info.bytes <= editorLimitMb * 1024 * 1024) {
                const sql = await api.scriptJobText(id);
                setResult({ jobId: id, sql, info, status, keptUntil, expired: false });
                // Shown in the editor, so there is nothing to download again.
                void api.deleteScriptJob(id).catch(() => undefined);
            } else {
                startDownload(api.scriptJobDownloadUrl(id), info.fileName);
                setResult({ jobId: id, sql: null, info, status, keptUntil, expired: false });
            }
            setStep(3);
        } catch (e) {
            // A job cancelled under the loop answers 404 to its next poll. That is not an error.
            if (id === null || jobRef.current === id) {
                setError(e instanceof Error ? e.message : String(e));
            }
        } finally {
            if (jobRef.current === id) {
                jobRef.current = null;
            }
            setBusy("");
            setRunning(null);
            setShowProgress(false);
            setCancelling(false);
        }
    };

    const cancel = () => {
        const id = jobRef.current;
        if (!id) {
            return;
        }
        setCancelling(true);
        jobRef.current = null;
        void api.deleteScriptJob(id).catch(() => undefined);
    };

    // Leaving the panel stops the job it was waiting for. The server would give up on it after a
    // while anyway, but a read of fifty thousand modules should not run on for nobody.
    useEffect(
        () => () => {
            const id = jobRef.current;
            if (id) {
                jobRef.current = null;
                void api.deleteScriptJob(id).catch(() => undefined);
            }
        },
        [],
    );

    // Download again stops working when the server deletes the file. Say so at that moment rather
    // than letting the button fail.
    useEffect(() => {
        if (!result || result.sql !== null || result.expired) {
            return;
        }
        const timer = window.setTimeout(
            () => setResult((current) => (current === result ? { ...current, expired: true } : current)),
            Math.max(0, result.keptUntil - Date.now()),
        );
        return () => window.clearTimeout(timer);
    }, [result]);

    if (inventory.loading) {
        return <div className="state">Reading the object list…</div>;
    }
    if (inventory.error) {
        return <div className="error">{inventory.error}</div>;
    }

    // In data only, a set with no rows chosen anywhere would script nothing.
    const blocked = targets.length === 0 || unbounded.length > 0 || (dataOnly && withData === 0);

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
                    <button
                        className="step"
                        aria-current={step === 3 || showProgress}
                        disabled={!result}
                        onClick={() => setStep(3)}
                    >
                        <b>3</b> Script
                    </button>
                </span>
                <span className="tool-sep" />
                <span className="seg outseg" role="radiogroup" aria-label="Script output">
                    {OUTPUTS.map(([value, label]) => (
                        <button
                            key={value}
                            role="radio"
                            aria-checked={output === value}
                            className={output === value ? "on" : undefined}
                            onClick={() => setOutput(value)}
                        >
                            {label}
                        </button>
                    ))}
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
                {/* One group, so a narrow window moves both actions to the next line together
                    instead of leaving Generate there on its own. */}
                <span className="actions">
                    <span className="tool-sep" />
                    <button className="tool" onClick={() => run("files")} disabled={blocked || busy !== ""}>
                        {busy === "files" ? "Packing…" : "Download as files"}
                    </button>
                    <button className="tool run" onClick={() => run("script")} disabled={blocked || busy !== ""}>
                        <Icon name="play" size={14} />
                        {busy === "script" ? "Scripting…" : "Generate"}
                    </button>
                </span>
            </div>

            {error && <div className="error">{error}</div>}
            {unbounded.length > 0 && (
                <div className="warn-note">
                    {unbounded.length === 1 ? "This table has" : "These tables have"} more than{" "}
                    {warnRows.toLocaleString("en-US")} rows, so <b>all</b> is probably not what you want:{" "}
                    {unbounded.map((o) => o.schema + "." + o.name).join(", ")}. Use <b>top</b> or <b>query</b> instead.
                </div>
            )}

            {showProgress ? (
                <JobProgress
                    db={db}
                    status={running}
                    summary={jobSummary(dataOnly ? 0 : targets.length, withData)}
                    cancelling={cancelling}
                    onCancel={cancel}
                />
            ) : step === 3 && result ? (
                <>
                    {result.info.missing.length > 0 && (
                        <div className="warn-note">
                            {result.info.missing.length} asked for but no longer in the catalog:{" "}
                            {result.info.missing.join(", ")}
                        </div>
                    )}
                    {result.info.cycleTables.length > 0 && (
                        <div className="warn-note">
                            The chosen tables reference each other in a cycle, so no insert order satisfies
                            them. The script disables their constraints for the load and re-validates at the end.
                        </div>
                    )}
                    {result.sql === null ? (
                        <JobDone
                            result={result.info}
                            status={result.status}
                            limitMb={editorLimitMb}
                            downloadUrl={result.expired ? null : api.scriptJobDownloadUrl(result.jobId)}
                        />
                    ) : (
                        <>
                            <div className="script-out">
                                <Suspense fallback={<div className="editor-placeholder" />}>
                                    <SqlEditor value={result.sql} valueKey={result.jobId} />
                                </Suspense>
                            </div>
                            <div className="status">
                                <span>{result.info.scripted} scripted</span>
                                <span className="grow" />
                                <span>{(result.info.lines ?? 0).toLocaleString("en-US")} lines</span>
                            </div>
                        </>
                    )}
                </>
            ) : (
                <>
                    <div className="shuttle">
                        {/* ---- 1. choose ---- */}
                        <div className="spane source">
                            <FilterHead
                                search={search}
                                onSearch={setSearch}
                                shown={visible.length}
                                total={objects.length}
                                kinds={kinds}
                                kind={kind}
                                onKind={setKind}
                            />

                            {pasteOpen && (
                                <div className="pastebox">
                                    <textarea
                                        className="mono"
                                        autoFocus
                                        spellCheck={false}
                                        placeholder="dbo.Countries; dbo.Currencies; sales.Orders"
                                        value={pasteText}
                                        onChange={(e) => setPasteText(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                                e.preventDefault();
                                                tickPasted();
                                            } else if (e.key === "Escape") {
                                                setPasteOpen(false);
                                            }
                                        }}
                                    />
                                    <div className="bar">
                                        <span className="muted">; or a new line between names. Schema optional.</span>
                                        <span className="grow" />
                                        <button className="tool" onClick={() => setPasteOpen(false)}>
                                            Cancel
                                        </button>
                                        <button className="tool run" disabled={!pasteText.trim()} onClick={tickPasted}>
                                            Tick
                                        </button>
                                    </div>
                                </div>
                            )}

                            {pasteOutcome && !pasteOpen && (
                                <div className="listnote">
                                    <span className="grow">
                                        <span className="ok">
                                            {pasteOutcome.found.length} of {pasteOutcome.names.length} ticked
                                        </span>
                                        {pasteOutcome.notFound.length > 0 && (
                                            <span className="bad">
                                                not found: <span className="mono">{pasteOutcome.notFound.join(", ")}</span>
                                            </span>
                                        )}
                                        {pasteOutcome.ambiguous.length > 0 && (
                                            <span className="bad">
                                                in more than one schema, not ticked:{" "}
                                                <span className="mono">{pasteOutcome.ambiguous.join(", ")}</span>
                                            </span>
                                        )}
                                    </span>
                                    <button className="addbtn" title="Dismiss" onClick={() => setPasteOutcome(null)}>
                                        ×
                                    </button>
                                </div>
                            )}

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
                                                {count === null ? "?" : count !== undefined && count > 0 ? count.toLocaleString("en-US") : ""}
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
                                <button
                                    className="tool"
                                    aria-pressed={pasteOpen}
                                    onClick={() => setPasteOpen((open) => !open)}
                                    title="Tick objects by name: paste a list separated by ; or new lines"
                                >
                                    Paste list…
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
                                    {dataOnly
                                        ? `data only · ${withData} ${withData === 1 ? "table" : "tables"} scripted`
                                        : `${targets.length - withData} ddl · ${withData} data`}
                                </span>
                                <button
                                    className="tool"
                                    disabled={targets.length === 0}
                                    onClick={() => {
                                        onSelection(EMPTY);
                                        setActive(null);
                                        setTicked(new Set());
                                    }}
                                >
                                    Clear
                                </button>
                            </div>

                            {targets.length > 0 && (
                                <FilterHead
                                    search={chosenSearch}
                                    onSearch={(search) => filterChosen({ search })}
                                    shown={chosenVisible.length}
                                    total={targets.length}
                                    kinds={chosenKinds}
                                    kind={chosenKind}
                                    onKind={(kind) => filterChosen({ kind })}
                                />
                            )}

                            <div className="picker-rows set-rows">
                                {targets.length === 0 ? (
                                    <div className="panel-empty">
                                        <b>Nothing chosen yet</b>
                                        <span>Tick objects on the left, then Move.</span>
                                    </div>
                                ) : (
                                    <>
                                        <table className="setgrid">
                                            <thead>
                                                <tr>
                                                    <th className="tick" />
                                                    <th className="num">#</th>
                                                    <th>Object</th>
                                                    <th>Kind</th>
                                                    <th>Rows</th>
                                                    <th className="num">Count</th>
                                                    <th />
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {chosenVisible.slice(0, RENDER_CAP).map((o, index) => {
                                                    const id = idOf(o);
                                                    return (
                                                        <SetRow
                                                            key={id}
                                                            object={o}
                                                            id={id}
                                                            index={index}
                                                            mode={modeOf(id)}
                                                            count={countLabel(modeOf(id), id, counted, rowCounts, tops)}
                                                            idle={idleReason(o, modeOf(id), dataOnly)}
                                                            active={active === id}
                                                            ticked={ticked.has(id)}
                                                            onPick={setActive}
                                                            onMode={chooseMode}
                                                            onTick={tick}
                                                            onRemove={remove}
                                                        />
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                        {chosenVisible.length > RENDER_CAP && (
                                            <div className="state">
                                                Showing the first {RENDER_CAP} of {chosenVisible.length}. The buttons below
                                                act on all of them.
                                            </div>
                                        )}
                                        {chosenVisible.length === 0 && <div className="state">Nothing matches.</div>}
                                    </>
                                )}
                            </div>

                            {targets.length > 0 && (
                                <div className="picker-foot">
                                    <button
                                        className="tool run move"
                                        disabled={tickedObjects.length === 0}
                                        onClick={removeTicked}
                                        title="Take everything ticked out of the script set"
                                    >
                                        « Remove {tickedObjects.length > 0 ? tickedObjects.length : ""}
                                    </button>
                                    <span className="grow" />
                                    <button
                                        className="tool"
                                        disabled={chosenVisible.length === 0}
                                        onClick={() => tickBulk("select")}
                                    >
                                        All {chosenVisible.length}
                                    </button>
                                    <button
                                        className="tool"
                                        disabled={tickedObjects.length === 0}
                                        onClick={() => setTicked(new Set())}
                                    >
                                        None
                                    </button>
                                    <button
                                        className="tool"
                                        disabled={chosenVisible.length === 0}
                                        onClick={() => tickBulk("invert")}
                                    >
                                        Invert
                                    </button>
                                </div>
                            )}
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
    // Set when the object produces nothing in the current output, with the reason to show.
    idle: string | null;
    active: boolean;
    ticked: boolean;
    onPick: (id: string) => void;
    onMode: (id: string, next: Rows) => void;
    onTick: (index: number, shift: boolean) => void;
    onRemove: (o: ScriptableObject) => void;
}

const SetRow = memo(function SetRow({
    object,
    id,
    index,
    mode,
    count,
    idle,
    active,
    ticked,
    onPick,
    onMode,
    onTick,
    onRemove,
}: SetRowProps) {
    const table = object.kind === "tables";
    const classes = [active ? "active" : "", idle ? "idle" : ""].filter(Boolean).join(" ");
    return (
        <tr className={classes || undefined} onClick={() => onPick(id)}>
            <td className="tick">
                <span
                    role="checkbox"
                    aria-checked={ticked}
                    aria-label={`Tick ${object.schema}.${object.name}`}
                    className="tri"
                    onClick={(e) => {
                        e.stopPropagation();
                        onTick(index, e.shiftKey);
                    }}
                />
            </td>
            <td className="num muted">{index + 1}</td>
            <td className="mono">
                {object.schema}.{object.name}
            </td>
            <td className="muted">{KIND_LABEL[object.kind] ?? object.kind}</td>
            <td className="keep">
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
            <td className="num">{idle ? <span className="idle-tag">{idle}</span> : count}</td>
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
    rowCounts: Map<string, number | null>,
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
            if (estimate === null) {
                return "?";
            }
            return estimate !== undefined ? "~" + estimate.toLocaleString("en-US") : "—";
    }
}

// Why a row of the set produces nothing, or null when it does. Only data only leaves rows out:
// with definitions in the script every object in the set is in it.
function idleReason(o: ScriptableObject, mode: Rows, dataOnly: boolean): string | null {
    if (!dataOnly) {
        return null;
    }
    // Short on purpose: the tag sits in the COUNT column and must not widen it.
    if (o.kind !== "tables") {
        return "skipped";
    }
    return mode === "none" ? "no rows" : null;
}

// Hands a URL to the browser's own download. The server names the file in Content-Disposition,
// so a 7-Zip archive keeps its .7z.
function startDownload(url: string, fileName: string) {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function jobSummary(objects: number, tablesWithRows: number): string {
    const parts: string[] = [];
    if (objects > 0) {
        parts.push(`${objects.toLocaleString("en-US")} ${objects === 1 ? "object" : "objects"}`);
    }
    if (tablesWithRows > 0) {
        parts.push(`${tablesWithRows.toLocaleString("en-US")} ${tablesWithRows === 1 ? "table" : "tables"} with rows`);
    }
    return parts.join(" · ");
}

function matches(o: ScriptableObject, needle: string): boolean {
    if (!needle) {
        return true;
    }
    return (o.schema + "." + o.name).toLowerCase().includes(needle);
}

interface FilterHeadProps {
    search: string;
    onSearch: (next: string) => void;
    shown: number;
    total: number;
    kinds: string[];
    kind: string;
    onKind: (next: string) => void;
}

// The search box and type chips over a list. Both panes have one, so a set of thousands can be
// narrowed down the same way the inventory is.
function FilterHead({ search, onSearch, shown, total, kinds, kind, onKind }: FilterHeadProps) {
    return (
        <div className="pane-head">
            <div className="searchrow">
                <input
                    type="search"
                    className="search"
                    placeholder="Search…"
                    value={search}
                    onChange={(e) => onSearch(e.target.value)}
                />
                <span className="ratio">
                    {shown} / {total}
                </span>
            </div>
            <div className="kinds">
                <button className="chip" aria-pressed={kind === ""} onClick={() => onKind("")}>
                    All
                </button>
                {kinds.map((k) => (
                    <button key={k} className="chip" aria-pressed={kind === k} onClick={() => onKind(kind === k ? "" : k)}>
                        {KIND_LABEL[k] ?? k}
                    </button>
                ))}
            </div>
        </div>
    );
}
