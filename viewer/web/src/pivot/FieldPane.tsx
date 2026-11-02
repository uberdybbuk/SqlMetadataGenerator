import { useMemo, useRef, useState, type DragEvent } from "react";

import type { ColumnSummary, PivotAgg, PivotGrain } from "../api";
import { isNumericType } from "../cell";
import { Icon } from "../Icon";
import {
    AGGREGATES,
    filterSummary,
    measureLabel,
    move,
    place,
    refusal,
    remove,
    tick,
    untick,
    usedColumns,
    type Area,
    type Layout,
} from "./layout";

// Excel's field list: every column of the table, ticked when it is in use, and the four areas a
// field is dragged between. Ticking puts a field where Excel would; dragging puts it exactly where
// it is dropped.

const GRAINS: PivotGrain[] = ["year", "quarter", "month", "day"];

const AREAS: { area: Area; title: string; hint: string }[] = [
    { area: "filters", title: "Filters", hint: "Drop to filter by value" },
    { area: "columns", title: "Columns", hint: "Drop for column headers" },
    { area: "rows", title: "Rows", hint: "Drop to group rows" },
    { area: "values", title: "Values", hint: "Drop to add up or count" },
];

// What is being dragged. Kept here rather than read from the drag event: during dragover the
// browser only says THAT something is being dragged, not what, and whether an area accepts it
// depends on what it is.
interface Dragged {
    column: string | null;
    from?: { area: Area; index: number };
}

interface FieldPaneProps {
    columns: ColumnSummary[];
    layout: Layout;
    onLayout: (next: Layout) => void;
    running: boolean;
    runBlocker: string | null;
    onRun: () => void;
    autoRun: boolean;
    onAutoRun: (on: boolean) => void;
}

export function FieldPane({ columns, layout, onLayout, running, runBlocker, onRun, autoRun, onAutoRun }: FieldPaneProps) {
    const [search, setSearch] = useState("");
    const [hot, setHot] = useState<Area | null>(null);
    const dragged = useRef<Dragged | null>(null);

    const byName = useMemo(() => new Map(columns.map((c) => [c.name, c])), [columns]);
    const used = usedColumns(layout);
    const words = search.trim().toLowerCase();
    const listed = words ? columns.filter((c) => c.name.toLowerCase().includes(words)) : columns;

    const accepts = (area: Area): boolean => {
        const drag = dragged.current;
        if (!drag) {
            return false;
        }
        if (drag.column === null) {
            // The Count measure has no field behind it; it only moves within Values.
            return area === "values";
        }
        const column = byName.get(drag.column);
        return column !== undefined && refusal(column, area) === null;
    };

    // Dropped on a pill: in front of it. Dropped on the empty part of an area: at the end.
    const indexAt = (event: DragEvent, area: Area): number => {
        const pill = (event.target as HTMLElement).closest<HTMLElement>("[data-index]");
        return pill ? Number(pill.dataset.index) : (layout[area] as unknown[]).length;
    };

    const drop = (event: DragEvent, area: Area) => {
        event.preventDefault();
        setHot(null);
        const drag = dragged.current;
        // Checked before the drag is forgotten: accepts() reads it.
        const allowed = accepts(area);
        dragged.current = null;
        if (!drag || !allowed) {
            return;
        }
        const index = indexAt(event, area);
        if (drag.column === null) {
            onLayout(move(layout, { name: "" } as ColumnSummary, drag.from!, "values", index));
            return;
        }
        const column = byName.get(drag.column)!;
        onLayout(drag.from ? move(layout, column, drag.from, area, index) : place(layout, column, area, index));
    };

    const startDrag = (event: DragEvent, payload: Dragged) => {
        dragged.current = payload;
        event.dataTransfer.effectAllowed = "move";
        // Firefox starts no drag without data on it.
        event.dataTransfer.setData("text/plain", payload.column ?? "Count");
    };

    const pill = (area: Area, index: number, column: string | null, body: React.ReactNode) => (
        <span
            key={`${area}:${index}:${column}`}
            className={area === "filters" ? "ppill filter" : "ppill"}
            data-index={index}
            draggable
            onDragStart={(e) => startDrag(e, { column, from: { area, index } })}
            onDragEnd={() => {
                dragged.current = null;
                setHot(null);
            }}
        >
            {body}
            <button type="button" className="x" aria-label="Remove" onClick={() => onLayout(remove(layout, area, index))}>
                ×
            </button>
        </span>
    );

    return (
        <aside className="pfields">
            <div className="plabel">Fields</div>
            <input
                type="search"
                className="pfield-search"
                placeholder={`Search ${columns.length} columns…`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
            />
            <div className="pfield-list">
                {listed.map((column) => {
                    const on = used.has(column.name);
                    return (
                        <label
                            key={column.name}
                            className={on ? "pfield on" : "pfield"}
                            draggable
                            onDragStart={(e) => startDrag(e, { column: column.name })}
                            onDragEnd={() => {
                                dragged.current = null;
                                setHot(null);
                            }}
                        >
                            <input
                                type="checkbox"
                                checked={on}
                                onChange={() => onLayout(on ? untick(layout, column.name) : tick(layout, column))}
                            />
                            <span className="name">{column.name}</span>
                            <span className="type">{column.typeName}</span>
                        </label>
                    );
                })}
                {listed.length === 0 && <div className="pfield-none">No column matches.</div>}
            </div>

            <div className="plabel">Drag fields between areas</div>
            <div className="pareas">
                {AREAS.map(({ area, title, hint }) => (
                    <div key={area} className="parea">
                        <div className="plabel">{title}</div>
                        <div
                            className={hot === area ? "pzone hot" : "pzone"}
                            onDragOver={(e) => {
                                if (accepts(area)) {
                                    e.preventDefault();
                                    e.dataTransfer.dropEffect = "move";
                                    setHot(area);
                                }
                            }}
                            onDragLeave={(e) => {
                                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                                    setHot(null);
                                }
                            }}
                            onDrop={(e) => drop(e, area)}
                        >
                            {area === "filters" &&
                                layout.filters.map((f, i) =>
                                    pill(area, i, f.column, (
                                        <span className="ptext" title={filterSummary(f)}>
                                            {f.column}
                                        </span>
                                    )),
                                )}
                            {(area === "rows" || area === "columns") &&
                                layout[area].map((f, i) =>
                                    pill(area, i, f.column, (
                                        <>
                                            <span className="ptext">{f.column}</span>
                                            {f.grain && f.grain !== "none" && (
                                                <select
                                                    value={f.grain}
                                                    aria-label="Period"
                                                    onChange={(e) =>
                                                        onLayout({
                                                            ...layout,
                                                            [area]: layout[area].map((g, j) =>
                                                                j === i ? { ...g, grain: e.target.value as PivotGrain } : g,
                                                            ),
                                                        })
                                                    }
                                                >
                                                    {GRAINS.map((g) => (
                                                        <option key={g} value={g}>
                                                            by {g}
                                                        </option>
                                                    ))}
                                                </select>
                                            )}
                                        </>
                                    )),
                                )}
                            {area === "values" &&
                                layout.values.map((v, i) => {
                                    const column = v.column ? byName.get(v.column) : undefined;
                                    const choices = AGGREGATES.filter(
                                        (a) => a.value !== "count" && (!a.numericOnly || (column && isNumericType(column.typeName))),
                                    );
                                    return pill(area, i, v.column ?? null, (
                                        column ? (
                                            <select
                                                value={v.agg}
                                                aria-label="Summarise by"
                                                onChange={(e) =>
                                                    onLayout({
                                                        ...layout,
                                                        values: layout.values.map((w, j) =>
                                                            j === i ? { ...w, agg: e.target.value as PivotAgg } : w,
                                                        ),
                                                    })
                                                }
                                            >
                                                {choices.map((a) => (
                                                    <option key={a.value} value={a.value}>
                                                        {a.label(v.column)}
                                                    </option>
                                                ))}
                                            </select>
                                        ) : (
                                            <span className="ptext">{measureLabel(v)}</span>
                                        )
                                    ));
                                })}
                            {(layout[area] as unknown[]).length === 0 && <span className="phint">{hint}</span>}
                        </div>
                    </div>
                ))}
            </div>
            {!layout.values.some((v) => v.agg === "count") && (
                <button
                    type="button"
                    className="link-button padd-count"
                    onClick={() => onLayout({ ...layout, values: [...layout.values, { agg: "count" }] })}
                >
                    + Count rows
                </button>
            )}

            <div className="prun">
                <button type="button" className="tool run" onClick={onRun} disabled={running || runBlocker !== null} title={runBlocker ?? undefined}>
                    <Icon name="play" size={14} />
                    {running ? "Running…" : "Run"}
                </button>
                <label className="pauto">
                    <input type="checkbox" checked={autoRun} onChange={(e) => onAutoRun(e.target.checked)} />
                    Run on every change
                </label>
            </div>
            {runBlocker && <div className="pblocker">{runBlocker}</div>}
        </aside>
    );
}
