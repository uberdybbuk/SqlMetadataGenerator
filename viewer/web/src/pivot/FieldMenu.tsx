import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { ColumnSummary, PivotOp, PivotValueField } from "../api";
import { OPERATORS, isNumericMeasure, measureKey, measureLabel, type LayoutField } from "./layout";

// A Rows or Columns field's menu, after Excel's: how its groups are ordered, and which of them
// are kept by a measure ("Count > 1"). Both apply within the field's parent group.
//
// Fixed to the window rather than placed inside the field pane: the pane scrolls, and a menu cut
// off at its edge would hide the OK button.

interface FieldMenuProps {
    field: LayoutField;
    values: PivotValueField[];
    columns: ColumnSummary[];
    anchor: DOMRect;
    onApply: (next: LayoutField) => void;
    onClose: () => void;
}

// The sort choices as one value each, for the radio group: "label:asc", "<measureKey>:desc" ...
const LABEL = "label";

export function FieldMenu({ field, values, columns, anchor, onApply, onClose }: FieldMenuProps) {
    const box = useRef<HTMLDivElement>(null);
    const numeric = values.filter((v) => isNumericMeasure(v, columns));
    const known = (key: string | undefined) => key !== undefined && values.some((v) => measureKey(v) === key);

    const [sort, setSort] = useState(() =>
        known(field.sortBy) ? `${field.sortBy}|${field.sortDesc ? "desc" : "asc"}` : `${LABEL}|${field.sortDesc ? "desc" : "asc"}`,
    );
    const [measure, setMeasure] = useState(() =>
        field.keep && known(field.keep.measure) ? field.keep.measure : (numeric[0] ? measureKey(numeric[0]) : ""),
    );
    const [op, setOp] = useState<PivotOp>(field.keep?.op ?? "gt");
    const [text, setText] = useState(field.keep && known(field.keep.measure) ? String(field.keep.value) : "");

    const number = text.trim() === "" ? null : Number(text);
    const invalid = number !== null && !Number.isFinite(number);

    // Under the pill, or above it when the window has no room below. Measured once drawn, since
    // the menu's height depends on how many measures it lists.
    // Written straight onto the element, before the first paint, so it never shows in the wrong
    // place for a frame.
    useLayoutEffect(() => {
        const el = box.current;
        if (!el) {
            return;
        }
        const below = anchor.bottom + 4;
        const top = below + el.offsetHeight > window.innerHeight - 8 ? Math.max(8, anchor.top - 4 - el.offsetHeight) : below;
        el.style.top = `${top}px`;
        el.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - 316))}px`;
    }, [anchor]);

    // A click anywhere else, or Escape, closes it without applying, as a menu does.
    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            if (box.current && !box.current.contains(e.target as Node)) {
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

    const apply = () => {
        const [by, direction] = sort.split("|");
        onApply({
            ...field,
            sortBy: by === LABEL ? undefined : by,
            // Labels A to Z is the default, so it is not stored.
            sortDesc: direction === "desc" ? true : undefined,
            keep: number !== null && !invalid && measure ? { measure, op, value: number } : undefined,
        });
    };

    const option = (value: string, label: string) => (
        <label key={value} className="ppicker-row">
            <input type="radio" name="pfield-sort" checked={sort === value} onChange={() => setSort(value)} />
            {label}
        </label>
    );

    return (
        <div
            className="ppicker pmenu"
            ref={box}
            role="dialog"
            aria-label={`${field.column} sort and filter`}
            style={{ position: "fixed", top: anchor.bottom + 4, left: anchor.left }}
        >
            <div className="pmenu-title">{field.column}</div>

            <div className="plabel">Sort</div>
            <div className="pmenu-group">
                {option(`${LABEL}|asc`, `${field.column}, A to Z`)}
                {option(`${LABEL}|desc`, `${field.column}, Z to A`)}
                {values.flatMap((v) => [
                    option(`${measureKey(v)}|desc`, `${measureLabel(v)}, largest first`),
                    option(`${measureKey(v)}|asc`, `${measureLabel(v)}, smallest first`),
                ])}
            </div>

            <div className="plabel">Show only groups where</div>
            {numeric.length === 0 ? (
                <div className="ppicker-note">Put a count or a sum in Values to filter the groups by it.</div>
            ) : (
                <div className="pmenu-filter">
                    <select value={measure} onChange={(e) => setMeasure(e.target.value)} aria-label="Measure">
                        {numeric.map((v) => (
                            <option key={measureKey(v)} value={measureKey(v)}>
                                {measureLabel(v)}
                            </option>
                        ))}
                    </select>
                    <select value={op} onChange={(e) => setOp(e.target.value as PivotOp)} aria-label="Comparison">
                        {OPERATORS.map((o) => (
                            <option key={o.value} value={o.value}>
                                {o.label}
                            </option>
                        ))}
                    </select>
                    <input
                        type="text"
                        inputMode="decimal"
                        className={invalid ? "mono invalid" : "mono"}
                        value={text}
                        placeholder="any"
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && !invalid && apply()}
                        aria-label="Value"
                    />
                </div>
            )}
            {invalid && <div className="ppicker-note error-text">Not a number.</div>}

            <div className="ppicker-actions">
                <button type="button" className="link-button pmenu-clear" onClick={() => setText("")} disabled={text === ""}>
                    Clear filter
                </button>
                <button type="button" className="tool" onClick={onClose}>
                    Cancel
                </button>
                <button type="button" className="tool primary" onClick={apply} disabled={invalid}>
                    OK
                </button>
            </div>
        </div>
    );
}
