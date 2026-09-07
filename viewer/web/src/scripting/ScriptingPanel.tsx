import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, type ScriptRequest, type ScriptResult } from "../api";
import { useApi } from "../useApi";
import { useFillHeight } from "../useFillHeight";
import { Icon, type IconName } from "../Icon";
import {
    ALL,
    EMPTY,
    PARTIAL,
    apply,
    bulk,
    idOf,
    resolve,
    stateOf,
    type ScriptableObject,
    type Selection,
    type Target,
} from "./selection";

const SqlEditor = lazy(() => import("../SqlEditor"));

// How many matching rows are drawn at once. The bulk buttons are NOT limited by this — they say
// the real match count in their labels and act on all of it. Rendering four thousand rows nobody
// will scroll through is the only thing the cap avoids.
const RENDER_CAP = 300;

// Above this a table's rows are not something to tick without thinking, so the picker asks for a
// WHERE. It is a warning, not a limit — the server has its own ceiling, which fails rather than
// truncating. Mirrors DataScripter.WarnRows.
const WARN_ROWS = 1000;

const ICONS: Record<string, IconName> = {
    schemas: "schema",
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

type Grouping = "type" | "schema";

// One line in the picker. Containers and objects are the same shape so that the keyboard, the
// range select and the tri-state box all have one thing to work with.
interface Row {
    key: string;
    depth: number;
    label: string;
    icon?: IconName;
    // The kind, when the label does not carry it (the flat filtered list).
    title?: string;
    target: Target;
    // What the box reflects. For an object it is that object alone.
    members: ScriptableObject[];
    container: boolean;
}

interface ScriptingPanelProps {
    alias: string;
    db: string;
    // The selection is held by the PAGE, not by this component. Leaving the panel for the overview
    // unmounts it, and a picker that forgot seventeen ticks because the user glanced at the treemap
    // would be a picker nobody trusts to leave.
    selection: Selection;
    onSelection: (next: Selection) => void;
}

export function ScriptingPanel({ alias, db, selection, onSelection }: ScriptingPanelProps) {
    const inventory = useApi(() => api.scriptable(alias, db), [alias, db]);
    // Row counts, so the picker can warn BEFORE someone ticks an eleven-million-row log table
    // rather than after the download starts. Approximate (sys.partitions), which is the right
    // precision for a warning.
    const stats = useApi(() => api.tables(alias, db), [alias, db]);
    const [grouping, setGrouping] = useState<Grouping>("type");
    const [search, setSearch] = useState("");
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [options, setOptions] = useState({
        upperCaseKeywords: false,
        emitSetOptions: false,
        groupColumns: true,
    });
    // Data is a SECOND selection over the same inventory, restricted to tables: scripting forty
    // tables' DDL and three tables' rows is the normal case, and one switch covering both would
    // force two passes to get it.
    const [dataSelection, setDataSelection] = useState<Selection>(EMPTY);
    // The WHERE per table, keyed the same way the engine keys objects.
    const [wheres, setWheres] = useState<Record<string, string>>({});
    const [result, setResult] = useState<ScriptResult | null>(null);
    const [busy, setBusy] = useState<"" | "script" | "files">("");
    const [error, setError] = useState<string | null>(null);
    const { frame, height } = useFillHeight(360);

    const objects = useMemo(() => inventory.data?.objects ?? [], [inventory.data]);
    const titles = useMemo(() => {
        const map = new Map<string, string>();
        for (const k of inventory.data?.kinds ?? []) {
            map.set(k.kind, k.title);
        }
        return map;
    }, [inventory.data]);

    const selected = useMemo(() => resolve(objects, selection), [objects, selection]);

    const tables = useMemo(() => objects.filter((o) => o.kind === "tables"), [objects]);
    const dataSelected = useMemo(() => resolve(tables, dataSelection), [tables, dataSelection]);

    const rowCounts = useMemo(() => {
        const map = new Map<string, number>();
        for (const t of stats.data ?? []) {
            map.set(idOf({ kind: "tables", schema: t.schema, name: t.name }), t.rowCount);
        }
        return map;
    }, [stats.data]);

    const needle = search.trim().toLowerCase();
    // Matches come from the WHOLE inventory, never from what happens to be expanded. A filter that
    // only searched the open branches would answer a different question than the one being asked.
    const matches = useMemo(
        () =>
            needle
                ? objects.filter(
                      (o) =>
                          o.name.toLowerCase().includes(needle) ||
                          o.schema.toLowerCase().includes(needle) ||
                          `${o.schema}.${o.name}`.toLowerCase().includes(needle),
                  )
                : null,
        [objects, needle],
    );

    const rows = useMemo(
        () => (matches ? flatRows(matches, titles) : treeRows(objects, grouping, expanded, titles)),
        [matches, objects, grouping, expanded, titles],
    );

    // The row the keyboard acts on and the anchor a shift+click extends from, as an index into
    // the rows currently on screen. State rather than a ref: it is drawn.
    const [focus, setFocus] = useState<number | null>(null);
    const list = useRef<HTMLDivElement>(null);

    // Brought JUST into view, never centred. Centring on every keystroke makes the list jump
    // under the reader, which is worse than a row sitting at the edge.
    useEffect(() => {
        if (focus === null || !list.current) {
            return;
        }
        // Queried by index rather than taken from children[]: a row with its WHERE box open
        // contributes two elements, so positions and child indexes stopped agreeing.
        const el = list.current.querySelector(`[data-row="${focus}"]`);
        if (el instanceof HTMLElement) {
            el.scrollIntoView({ block: "nearest" });
        }
    }, [focus]);

    const setExpansion = useCallback((key: string, open: boolean) => {
        setExpanded((current) => {
            const next = new Set(current);
            if (open) {
                next.add(key);
            } else {
                next.delete(key);
            }
            return next;
        });
    }, []);

    const toggle = useCallback(
        (row: Row, next?: boolean) => {
            const state = stateOf(row.members, selected);
            // A half-ticked container ticks fully — nobody clicks a mixed box hoping to empty it.
            const include = next ?? state !== ALL;
            onSelection(apply(selection, row.target, include));
        },
        [selected, selection, onSelection],
    );

    // Ticking data on a container means "the rows of every table under it", which is the same
    // statement the schema box makes — so it goes through the same engine, over the tables only.
    const toggleData = useCallback(
        (row: Row) => {
            const members = row.members.filter((o) => o.kind === "tables");
            if (members.length === 0) {
                return;
            }
            setDataSelection((current) =>
                apply(current, row.target, stateOf(members, dataSelected) !== ALL),
            );
        },
        [dataSelected],
    );

    const onRowClick = useCallback(
        (row: Row, index: number, event: React.MouseEvent, fromBox: boolean) => {
            // Shift extends from the last row acted on, over what is visible, and sets the whole
            // run to what the anchor row is being set to.
            if (event.shiftKey && focus !== null && rows[focus]) {
                const [from, to] = [focus, index].sort((a, b) => a - b);
                // The whole run takes the state the anchor is being moved TO, so a shift+click
                // never leaves half the range disagreeing with the row that started it.
                const include = stateOf(rows[focus].members, selected) !== ALL;
                let next = selection;
                for (let i = from; i <= to; i++) {
                    next = apply(next, rows[i].target, include);
                }
                onSelection(next);
                return;
            }

            setFocus(index);
            // On a container the common act is opening it; on an object it is picking it. Clicking
            // the box always picks, whichever kind of row it is.
            if (row.container && !fromBox) {
                setExpansion(row.key, !expanded.has(row.key));
                return;
            }
            toggle(row);
        },
        [rows, selected, toggle, focus, selection, onSelection, expanded, setExpansion],
    );

    // The tree keyboard set. Right opens a closed node and, pressed again, steps into it; Left
    // closes an open one and, on a closed one, steps out to the parent. That pairing is what makes
    // a tree navigable without the mouse, and it is what the file picker this panel is modelled on
    // settled on after trying the alternatives.
    const onKeyDown = useCallback(
        (event: React.KeyboardEvent) => {
            if (rows.length === 0) {
                return;
            }
            const at = focus ?? 0;
            const row = rows[at];
            const move = (to: number) => {
                event.preventDefault();
                setFocus(Math.max(0, Math.min(rows.length - 1, to)));
            };

            switch (event.key) {
                case "ArrowDown":
                    return move(focus === null ? 0 : at + 1);
                case "ArrowUp":
                    return move(focus === null ? 0 : at - 1);
                case "Home":
                    return move(0);
                case "End":
                    return move(rows.length - 1);
                case "PageDown":
                    return move(at + 10);
                case "PageUp":
                    return move(at - 10);
                case "ArrowRight":
                    event.preventDefault();
                    if (row.container && !expanded.has(row.key)) {
                        setExpansion(row.key, true);
                    } else if (row.container) {
                        move(at + 1);
                    }
                    return;
                case "ArrowLeft":
                    event.preventDefault();
                    if (row.container && expanded.has(row.key)) {
                        setExpansion(row.key, false);
                        return;
                    }
                    // Step out: the nearest row above that is one level shallower.
                    for (let i = at - 1; i >= 0; i--) {
                        if (rows[i].depth < row.depth) {
                            return move(i);
                        }
                    }
                    return;
                case " ":
                case "Enter":
                    event.preventDefault();
                    return toggle(row);
                default:
                    return;
            }
        },
        [rows, focus, expanded, setExpansion, toggle],
    );

    const runBulk = useCallback(
        (scope: ScriptableObject[], action: "select" | "deselect" | "invert") => {
            onSelection(bulk(objects, resolve(objects, selection), scope, action));
        },
        [objects, selection, onSelection],
    );

    const chosen = useMemo(() => objects.filter((o) => selected.has(idOf(o))), [objects, selected]);
    const chosenData = useMemo(
        () => tables.filter((o) => dataSelected.has(idOf(o))),
        [tables, dataSelected],
    );

    // Tables whose rows were asked for, are bigger than the warning threshold, and have no WHERE
    // to cut them down. Named rather than counted: which table is the whole point.
    const unbounded = useMemo(
        () =>
            chosenData.filter((o) => {
                const id = idOf(o);
                return (rowCounts.get(id) ?? 0) > WARN_ROWS && !(wheres[id] ?? "").trim();
            }),
        [chosenData, rowCounts, wheres],
    );

    const request = (): ScriptRequest => ({
        objects: chosen.map((o) => ({ kind: o.kind, schema: o.schema, name: o.name })),
        data: chosenData.map((o) => ({
            schema: o.schema,
            name: o.name,
            where: (wheres[idOf(o)] ?? "").trim() || undefined,
        })),
        ...options,
    });

    const generate = async () => {
        setBusy("script");
        setError(null);
        try {
            setResult(await api.script(alias, db, request()));
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
            // The server decides the format (7-Zip when the host has it, zip otherwise) and says
            // so in Content-Disposition. Naming the file here would put ".zip" on a .7z.
            link.download = filenameFrom(headers) ?? `${db}-scripts.zip`;
            link.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy("");
        }
    };

    const nothingChosen = chosen.length === 0 && chosenData.length === 0;

    if (inventory.loading) {
        return <div className="state">Reading the object list…</div>;
    }
    if (inventory.error) {
        return <div className="error">{inventory.error}</div>;
    }

    return (
        <div className="scripting" ref={frame} style={height ? { height } : undefined}>
            <div className="picker">
                <div className="picker-head">
                    <div className="toolbar tight">
                        <span className="muted">group by</span>
                        <button
                            className="chip"
                            aria-pressed={grouping === "type"}
                            onClick={() => setGrouping("type")}
                        >
                            type
                        </button>
                        <button
                            className="chip"
                            aria-pressed={grouping === "schema"}
                            onClick={() => setGrouping("schema")}
                        >
                            schema
                        </button>
                    </div>
                    <input
                        type="search"
                        className="search"
                        placeholder="Search objects or schemas…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                    {matches && (
                        // Scoped to the matches and SAYING SO, with the true count rather than the
                        // number of rows drawn. A bare "Select all" next to a filter box is how
                        // someone acts on a set they never looked at.
                        <div className="bulkbar">
                            <span className="muted">
                                {matches.length} {matches.length === 1 ? "match" : "matches"}
                                {matches.length > RENDER_CAP && `, showing the first ${RENDER_CAP}`}
                            </span>
                            <span className="grow" />
                            <button className="tool" onClick={() => runBulk(matches, "select")}>
                                Select all {matches.length}
                            </button>
                            <button className="tool" onClick={() => runBulk(matches, "deselect")}>
                                Deselect all {matches.length}
                            </button>
                            <button className="tool" onClick={() => runBulk(matches, "invert")}>
                                Invert {matches.length}
                            </button>
                        </div>
                    )}
                </div>

                <div
                    className="picker-rows"
                    role="tree"
                    tabIndex={0}
                    ref={list}
                    onKeyDown={(e) => onKeyDown(e)}
                >
                    {rows.slice(0, matches ? RENDER_CAP : rows.length).map((row, index) => {
                        const state = stateOf(row.members, selected);
                        // The data box only exists where there are tables under the row. A view or
                        // a sequence has no rows to script, and an empty box you cannot tick is
                        // worse than no box.
                        const tableMembers = row.members.filter((o) => o.kind === "tables");
                        const dataState = stateOf(tableMembers, dataSelected);
                        const leafTable = !row.container && row.members[0]?.kind === "tables";
                        const id = leafTable ? idOf(row.members[0]) : "";
                        const where = wheres[id] ?? "";
                        const count = leafTable ? (rowCounts.get(id) ?? 0) : 0;
                        const shouldNarrow = dataState === ALL && count > WARN_ROWS && !where.trim();
                        return (
                            <Fragment key={row.key}>
                            <div
                                className={`prow${row.container ? " group" : ""}${focus === index ? " focus" : ""}`}
                                style={{ paddingLeft: 8 + row.depth * 16 }}
                                data-row={index}
                                onClick={(e) => onRowClick(row, index, e, false)}
                            >
                                {/* Drawn on every row, empty on a leaf. Without the spacer a
                                    child's box sat two pixels LEFT of its parent's, because only
                                    the parent was paying for a twisty. */}
                                <span className="twisty">
                                    {row.container ? (expanded.has(row.key) ? "▾" : "▸") : ""}
                                </span>
                                <span
                                    role="checkbox"
                                    aria-checked={state === ALL ? "true" : state === PARTIAL ? "mixed" : "false"}
                                    className="tri"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onRowClick(row, index, e, true);
                                    }}
                                />
                                {row.icon && <Icon name={row.icon} size={13} />}
                                <span className={row.container ? "pname" : "pname mono"} title={row.title}>
                                    {row.label}
                                </span>
                                {row.container && <span className="pcount">{row.members.length}</span>}
                                {leafTable && count > 0 && (
                                    <span className={shouldNarrow ? "pcount warn" : "pcount"}>
                                        {count.toLocaleString("en-US")}
                                    </span>
                                )}
                                {tableMembers.length > 0 && (
                                    <span
                                        role="checkbox"
                                        aria-checked={
                                            dataState === ALL ? "true" : dataState === PARTIAL ? "mixed" : "false"
                                        }
                                        className="tri data"
                                        title={`Script the rows of ${tableMembers.length} table${tableMembers.length === 1 ? "" : "s"}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setFocus(index);
                                            toggleData(row);
                                        }}
                                    />
                                )}
                            </div>
                            {leafTable && dataState === ALL && (
                                // The WHERE appears only once the rows are actually wanted. A text
                                // box on every table row would bury the tree it belongs to.
                                <div className="wrow" style={{ paddingLeft: 8 + row.depth * 16 + 18 }}>
                                    <input
                                        className="wclause"
                                        placeholder={shouldNarrow ? "WHERE — required, this table is large" : "WHERE (optional)"}
                                        value={where}
                                        aria-invalid={shouldNarrow}
                                        onClick={(e) => e.stopPropagation()}
                                        onChange={(e) =>
                                            setWheres((current) => ({ ...current, [id]: e.target.value }))
                                        }
                                    />
                                </div>
                            )}
                            </Fragment>
                        );
                    })}
                    {rows.length === 0 && <div className="state">Nothing matches.</div>}
                </div>

                <div className="picker-foot">
                    <span>
                        <b>{chosen.length}</b> of {objects.length}
                        {chosenData.length > 0 && (
                            <>
                                {" · "}
                                <b>{chosenData.length}</b> with data
                            </>
                        )}
                    </span>
                    <span className="grow" />
                    <button className="tool" onClick={() => runBulk(objects, "select")}>
                        All {objects.length}
                    </button>
                    <button className="tool" onClick={() => onSelection(EMPTY)}>
                        None
                    </button>
                    <button className="tool" onClick={() => runBulk(objects, "invert")}>
                        Invert {objects.length}
                    </button>
                </div>
            </div>

            <div className="output">
                <div className="qtoolbar">
                    <button
                        type="button"
                        className="tool run"
                        onClick={generate}
                        disabled={nothingChosen || unbounded.length > 0 || busy !== ""}
                    >
                        <Icon name="play" size={14} />
                        {busy === "script" ? "Scripting…" : "Generate"}
                    </button>
                    <button
                        type="button"
                        className="tool"
                        onClick={download}
                        disabled={nothingChosen || unbounded.length > 0 || busy !== ""}
                        title="One file per object, in the folder layout the generator writes to disk"
                    >
                        {busy === "files" ? "Zipping…" : "Download as files"}
                    </button>
                    <span className="tool-sep" />
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
                </div>

                {unbounded.length > 0 && (
                    // Blocking rather than advisory: these are the tables where "just tick it"
                    // produces a download nobody wanted and a read nobody meant to start.
                    <div className="warn-note">
                        {unbounded.length === 1 ? "This table has" : "These tables have"} more than{" "}
                        {WARN_ROWS.toLocaleString("en-US")} rows. Add a WHERE to narrow{" "}
                        {unbounded.length === 1 ? "it" : "them"} down:{" "}
                        {unbounded
                            .map((o) => `${o.schema}.${o.name} (${(rowCounts.get(idOf(o)) ?? 0).toLocaleString("en-US")})`)
                            .join(", ")}
                    </div>
                )}
                {result && result.cycleTables.length > 0 && (
                    <div className="warn-note">
                        The chosen tables reference each other in a cycle, so no insert order
                        satisfies them. The script disables their constraints for the load and
                        re-validates at the end.
                    </div>
                )}
                {error && <div className="error">{error}</div>}
                {result && result.missing.length > 0 && (
                    // Said out loud rather than silently absent: the inventory can be minutes old.
                    <div className="warn-note">
                        {result.missing.length} object{result.missing.length === 1 ? " was" : "s were"} asked
                        for but no longer in the catalog: {result.missing.join(", ")}
                    </div>
                )}

                <div className="output-editor">
                    <Suspense fallback={<div className="editor-placeholder" />}>
                        <SqlEditor value={result?.sql ?? ""} />
                    </Suspense>
                </div>

                <div className="status">
                    <span>
                        {result
                            ? `${result.scripted} scripted`
                            : `${chosen.length + chosenData.length} chosen`}
                    </span>
                    <span className="grow" />
                    {result && <span>{result.sql.split("\n").length} lines</span>}
                </div>
            </div>
        </div>
    );
}

// Content-Disposition carries the name the server chose, extension included.
function filenameFrom(headers: Headers): string | null {
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(headers.get("content-disposition") ?? "");
    return match ? decodeURIComponent(match[1]) : null;
}

// The filtered view: one flat list of every match in the inventory, no containers. Grouping a
// search result re-hides what the search just found.
function flatRows(matches: ScriptableObject[], titles: Map<string, string>): Row[] {
    return matches.map((o) => ({
        key: `m:${o.kind}/${o.schema}/${o.name}`,
        depth: 0,
        label: `${o.schema}.${o.name}`,
        icon: ICONS[o.kind],
        target: { scope: "object", kind: o.kind, schema: o.schema, name: o.name } as Target,
        members: [o],
        container: false,
        // The kind is not in the label here, so the icon carries it and this names it on hover.
        title: titles.get(o.kind),
    }));
}

// Three levels in both groupings, so the two outer levels always land on a rule the engine can
// express: kind and kind-within-schema in one, schema and the same kind-within-schema in the other.
function treeRows(
    objects: ScriptableObject[],
    grouping: Grouping,
    expanded: Set<string>,
    titles: Map<string, string>,
): Row[] {
    const rows: Row[] = [];
    const outerOf = (o: ScriptableObject) => (grouping === "type" ? o.kind : o.schema);
    const innerOf = (o: ScriptableObject) => (grouping === "type" ? o.schema : o.kind);

    // Insertion order is the inventory's order, which the server sorted; kinds come back in the
    // generator's dependency order and objects within a kind by schema then name.
    const outer = new Map<string, ScriptableObject[]>();
    for (const o of objects) {
        const key = outerOf(o);
        const list = outer.get(key);
        if (list) {
            list.push(o);
        } else {
            outer.set(key, [o]);
        }
    }

    for (const [outerKey, group] of outer) {
        const outerRowKey = `${grouping}:${outerKey}`;
        rows.push({
            key: outerRowKey,
            depth: 0,
            label: grouping === "type" ? (titles.get(outerKey) ?? outerKey) : outerKey,
            icon: grouping === "type" ? ICONS[outerKey] : "schema",
            target:
                grouping === "type"
                    ? { scope: "kind", kind: outerKey }
                    : { scope: "schema", schema: outerKey },
            members: group,
            container: true,
        });

        if (!expanded.has(outerRowKey)) {
            continue;
        }

        const inner = new Map<string, ScriptableObject[]>();
        for (const o of group) {
            const key = innerOf(o);
            const list = inner.get(key);
            if (list) {
                list.push(o);
            } else {
                inner.set(key, [o]);
            }
        }

        for (const [innerKey, members] of inner) {
            const innerRowKey = `${outerRowKey}/${innerKey}`;
            const kind = grouping === "type" ? outerKey : innerKey;
            const schema = grouping === "type" ? innerKey : outerKey;
            rows.push({
                key: innerRowKey,
                depth: 1,
                label: grouping === "type" ? innerKey : (titles.get(innerKey) ?? innerKey),
                icon: grouping === "type" ? "schema" : ICONS[innerKey],
                target: { scope: "kindSchema", kind, schema },
                members,
                container: true,
            });

            if (!expanded.has(innerRowKey)) {
                continue;
            }

            for (const o of members) {
                rows.push({
                    key: `${innerRowKey}/${o.name}`,
                    depth: 2,
                    label: o.name,
                    target: { scope: "object", kind: o.kind, schema: o.schema, name: o.name },
                    members: [o],
                    container: false,
                });
            }
        }
    }

    return rows;
}
