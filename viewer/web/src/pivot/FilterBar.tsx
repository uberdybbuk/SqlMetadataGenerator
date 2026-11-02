import { useEffect, useMemo, useRef, useState } from "react";

import { filterSummary, type FilterState } from "./layout";

// The filter fields above the matrix, each opening Excel's value list: tick the values to keep.
//
// The list shows the most frequent values, not necessarily all of them — a column can hold
// millions. So what a set of ticks MEANS is decided on OK: with most values ticked it is "all but
// the unticked ones", which also keeps every value the list never showed; with few ticked it is
// "only these". On a complete list the two say the same thing.

export interface ValueCount {
    value: string | null;
    count: number;
}

export interface ValueList {
    values: ValueCount[];
    // False when the list stopped at its limit and more values exist.
    complete: boolean;
}

interface FilterBarProps {
    filters: FilterState[];
    onChange: (index: number, next: FilterState) => void;
    onRemove: (index: number) => void;
    load: (column: string) => Promise<ValueList>;
}

export function FilterBar({ filters, onChange, onRemove, load }: FilterBarProps) {
    const [open, setOpen] = useState<number | null>(null);

    if (filters.length === 0) {
        return null;
    }

    return (
        <div className="pfilterbar">
            <span className="plabel">Filters</span>
            {filters.map((filter, i) => (
                <span key={filter.column} className="pchip-wrap">
                    <button
                        type="button"
                        className={filter.mode === "all" ? "pchip" : "pchip active"}
                        onClick={() => setOpen(open === i ? null : i)}
                        aria-expanded={open === i}
                    >
                        <span className="mono">
                            {filter.column}: {filterSummary(filter)}
                        </span>
                        <span className="caret">▾</span>
                    </button>
                    <button type="button" className="pchip-x" aria-label={`Remove ${filter.column}`} onClick={() => onRemove(i)}>
                        ×
                    </button>
                    {open === i && (
                        <ValuePicker
                            filter={filter}
                            load={load}
                            onApply={(next) => {
                                onChange(i, next);
                                setOpen(null);
                            }}
                            onClose={() => setOpen(null)}
                        />
                    )}
                </span>
            ))}
        </div>
    );
}

function ValuePicker({
    filter,
    load,
    onApply,
    onClose,
}: {
    filter: FilterState;
    load: (column: string) => Promise<ValueList>;
    onApply: (next: FilterState) => void;
    onClose: () => void;
}) {
    const [list, setList] = useState<ValueList | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [ticked, setTicked] = useState<Set<string | null> | null>(null);
    const [search, setSearch] = useState("");
    const box = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let live = true;
        load(filter.column).then(
            (answer) => {
                if (!live) {
                    return;
                }
                setList(answer);
                const chosen = new Set(filter.values);
                setTicked(
                    new Set(
                        answer.values
                            .map((v) => v.value)
                            .filter((v) => (filter.mode === "all" ? true : filter.mode === "include" ? chosen.has(v) : !chosen.has(v))),
                    ),
                );
            },
            (err) => live && setError(err instanceof Error ? err.message : String(err)),
        );
        return () => {
            live = false;
        };
    }, [filter, load]);

    // A click anywhere else, or Escape, closes it without applying — as a menu does.
    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            if (box.current && !box.current.parentElement?.contains(e.target as Node)) {
                onClose();
            }
        };
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [onClose]);

    const shown = useMemo(() => {
        const words = search.trim().toLowerCase();
        return (list?.values ?? []).filter((v) => !words || (v.value ?? "(null)").toLowerCase().includes(words));
    }, [list, search]);

    const all = list?.values ?? [];
    const allTicked = ticked !== null && all.every((v) => ticked.has(v.value));

    const toggle = (value: string | null) => {
        const next = new Set(ticked);
        if (next.has(value)) {
            next.delete(value);
        } else {
            next.add(value);
        }
        setTicked(next);
    };

    const apply = () => {
        if (!ticked) {
            return;
        }
        const on = all.filter((v) => ticked.has(v.value)).map((v) => v.value);
        const off = all.filter((v) => !ticked.has(v.value)).map((v) => v.value);
        if (off.length === 0) {
            onApply({ column: filter.column, mode: "all", values: [] });
        } else if (off.length <= on.length || !list!.complete) {
            // On an incomplete list "only these" would drop every value the list never showed, so
            // an unticked value always means "not this one" there.
            onApply({ column: filter.column, mode: "exclude", values: off });
        } else {
            onApply({ column: filter.column, mode: "include", values: on });
        }
    };

    return (
        <div className="ppicker" ref={box} role="dialog" aria-label={`Filter ${filter.column}`}>
            {error && <div className="error">{error}</div>}
            {!error && !list && <div className="state small">Reading the values…</div>}
            {list && (
                <>
                    <input
                        type="search"
                        placeholder="Search values"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        autoFocus
                    />
                    <div className="ppicker-list">
                        <label className="ppicker-row all">
                            <input
                                type="checkbox"
                                checked={allTicked}
                                onChange={() => setTicked(allTicked ? new Set() : new Set(all.map((v) => v.value)))}
                            />
                            (Select all)
                        </label>
                        {shown.map((v) => (
                            <label key={String(v.value) + (v.value === null ? "#null" : "")} className="ppicker-row">
                                <input type="checkbox" checked={ticked?.has(v.value) ?? false} onChange={() => toggle(v.value)} />
                                <span className={v.value === null ? "mono null-label" : "mono"}>{v.value ?? "(null)"}</span>
                                <span className="count">{v.count.toLocaleString("en-US")}</span>
                            </label>
                        ))}
                    </div>
                    {!list.complete && (
                        <div className="ppicker-note">
                            The {list.values.length} most frequent values. Unticking one keeps every value not listed.
                        </div>
                    )}
                    <div className="ppicker-actions">
                        <button type="button" className="tool" onClick={onClose}>
                            Cancel
                        </button>
                        <button type="button" className="tool primary" onClick={apply} disabled={!ticked || ticked.size === 0}>
                            OK
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}
