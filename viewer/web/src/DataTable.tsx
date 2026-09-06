import { type MouseEvent, type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

export type SortValue = string | number | boolean | null;

export interface Column<T> {
    key: string;
    header: ReactNode;
    // The card that opens on hovering the header. Secondary information such as the type lives
    // here: written into the header row it widened the column for no good reason.
    info?: ReactNode;
    // Numeric columns are right-aligned and sort descending on the first click.
    numeric?: boolean;
    // The raw value used for sorting. Without it the column cannot be sorted.
    sortValue?: (row: T) => SortValue;
    render: (row: T) => ReactNode;
    className?: string;
    // A cell class that varies by row (e.g. to paint a NULL cell).
    cellClassName?: (row: T) => string | undefined;
    // The header is drawn as-is: it is not wrapped in a sort/selection button and its
    // width is not measured. For columns that carry their own control, like the row
    // number — otherwise a button ends up nested inside a button.
    plain?: boolean;
}

interface DataTableProps<T> {
    columns: Column<T>[];
    rows: T[];
    rowKey: (row: T) => string;
    initialSort?: { key: string; desc?: boolean };
    // Applied AFTER sorting, so "the first N by this" keeps its meaning.
    limit?: number;
    // Tighter row height and smaller type, for the data grid.
    dense?: boolean;
    // Width adjustment by dragging the column edges.
    resizable?: boolean;
    // The upper bound on a measured width, so one long value cannot swallow the screen.
    maxWidth?: number;
    // Selection: clicking the header selects the column, and sorting moves to its own button.
    // Without it the whole header is the sort button (the behaviour on the list pages).
    selection?: {
        isRowSelected: (row: T) => boolean;
        isColumnSelected: (key: string) => boolean;
        isCellSelected: (row: T, key: string) => boolean;
        onRow: (row: T, additive: boolean) => void;
        onColumn: (key: string, additive: boolean) => void;
        onCell: (row: T, key: string, additive: boolean) => void;
    };
}

const MIN_WIDTH = 56;

export function DataTable<T>({
    columns,
    rows,
    rowKey,
    initialSort,
    limit,
    dense,
    resizable,
    maxWidth = 320,
    selection,
}: DataTableProps<T>) {
    const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(
        initialSort ? { key: initialSort.key, desc: initialSort.desc ?? false } : null,
    );
    const [widths, setWidths] = useState<Record<string, number> | null>(null);
    const tableRef = useRef<HTMLTableElement>(null);

    // The widths are measured from the browser's automatic layout and then frozen. Otherwise
    // table-layout:fixed would kick in from the start and give every column the same width.
    useLayoutEffect(() => {
        if (!resizable || widths || !tableRef.current) {
            return;
        }
        const cells = tableRef.current.querySelectorAll("thead th");
        const measured: Record<string, number> = {};
        cells.forEach((cell, i) => {
            const column = columns[i];
            if (column) {
                // plain columns are measured too: even when their width comes from CSS, their
                // contribution to the table's total width still has to count.
                measured[column.key] = Math.min(
                    maxWidth,
                    Math.max(MIN_WIDTH, Math.round(cell.getBoundingClientRect().width)),
                );
            }
        });
        if (Object.keys(measured).length > 0) {
            setWidths(measured);
        }
    }, [resizable, widths, columns, maxWidth]);

    // When the columns change (moving to another table) the measurement has to reset.
    const columnKeys = columns.map((c) => c.key).join("|");
    const previousKeys = useRef(columnKeys);
    if (previousKeys.current !== columnKeys) {
        previousKeys.current = columnKeys;
        if (widths) {
            setWidths(null);
        }
    }

    const startResize = useCallback((key: string, event: React.MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        const startX = event.clientX;
        const th = (event.currentTarget as HTMLElement).closest("th");
        const startWidth = th?.getBoundingClientRect().width ?? MIN_WIDTH;

        const onMove = (e: MouseEvent) => {
            const next = Math.max(MIN_WIDTH, Math.round(startWidth + e.clientX - startX));
            setWidths((current) => ({ ...(current ?? {}), [key]: next }));
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            document.body.classList.remove("resizing");
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        document.body.classList.add("resizing");
    }, []);

    const sorted = useMemo(() => {
        const column = sort && columns.find((c) => c.key === sort.key);
        if (!column?.sortValue) {
            return limit ? rows.slice(0, limit) : rows;
        }
        const direction = sort!.desc ? -1 : 1;
        const copy = [...rows].sort((a, b) => compare(column.sortValue!(a), column.sortValue!(b)) * direction);
        return limit ? copy.slice(0, limit) : copy;
    }, [rows, columns, sort, limit]);

    function toggle(column: Column<T>) {
        if (!column.sortValue) {
            return;
        }
        setSort((current) =>
            current?.key === column.key
                ? { key: column.key, desc: !current.desc }
                : // Numeric columns sort descending first: what you are after is usually the largest.
                  { key: column.key, desc: column.numeric === true },
        );
    }

    const fixed = resizable && widths !== null;
    // Under a fixed layout the table width is given EXPLICITLY. Left as "max-content" the
    // browser grows to fit the cell content and overrides the colgroup widths; left as
    // "auto" it stretches to the container. Both inflated the columns.
    const totalWidth = fixed ? Object.values(widths!).reduce((sum, w) => sum + w, 0) : undefined;

    return (
        <div className={dense ? "table-wrap dense" : "table-wrap"}>
            <table
                ref={tableRef}
                style={fixed ? { tableLayout: "fixed", width: totalWidth } : undefined}
            >
                {fixed && (
                    <colgroup>
                        {columns.map((c) => (
                            <col key={c.key} style={c.plain ? undefined : { width: widths![c.key] }} />
                        ))}
                    </colgroup>
                )}
                <thead>
                    <tr>
                        {columns.map((column) => {
                            const active = sort?.key === column.key;
                            const arrow = active ? (sort!.desc ? "↓" : "↑") : "⇅";
                            const selected = selection?.isColumnSelected(column.key) ?? false;
                            return (
                                <th
                                    key={column.key}
                                    className={[column.numeric ? "num" : "", selected ? "selected" : ""]
                                        .filter(Boolean)
                                        .join(" ")}
                                    aria-sort={active ? (sort!.desc ? "descending" : "ascending") : undefined}
                                    onMouseEnter={column.info ? placeInfoCard : undefined}
                                >
                                    {column.plain ? (
                                        column.header
                                    ) : selection ? (
                                        // The name selects and the arrow sorts: two separate buttons.
                                        <span className="sort">
                                            <button
                                                type="button"
                                                className="hname pick"
                                                onClick={(e) => selection.onColumn(column.key, e.metaKey || e.ctrlKey)}
                                            >
                                                {column.header}
                                            </button>
                                            {column.sortValue && (
                                                <button
                                                    type="button"
                                                    className={active ? "arrow sortbtn active" : "arrow sortbtn"}
                                                    onClick={() => toggle(column)}
                                                    aria-label="Sort"
                                                >
                                                    {arrow}
                                                </button>
                                            )}
                                        </span>
                                    ) : column.sortValue ? (
                                        <button
                                            type="button"
                                            className={active ? "sort active" : "sort"}
                                            onClick={() => toggle(column)}
                                        >
                                            <span className="hname">{column.header}</span>
                                            <span className="arrow">{active ? (sort!.desc ? "↓" : "↑") : ""}</span>
                                        </button>
                                    ) : (
                                        <span className="sort">
                                            <span className="hname">{column.header}</span>
                                        </span>
                                    )}
                                    {column.info && <span className="colinfo">{column.info}</span>}
                                    {resizable && !column.plain && (
                                        <span
                                            className="resizer"
                                            onMouseDown={(e) => startResize(column.key, e)}
                                            role="separator"
                                            aria-orientation="vertical"
                                            aria-label={`Resize column`}
                                        />
                                    )}
                                </th>
                            );
                        })}
                    </tr>
                </thead>
                <tbody>
                    {sorted.map((row) => {
                        const rowSelected = selection?.isRowSelected(row) ?? false;
                        return (
                            <tr key={rowKey(row)} className={rowSelected ? "selected" : undefined}>
                                {columns.map((column) => {
                                    const isRowNumber = column.className === "rownum";
                                    return (
                                        <td
                                            key={column.key}
                                            onClick={
                                                !selection
                                                    ? undefined
                                                    : isRowNumber
                                                      ? (e) => selection.onRow(row, e.metaKey || e.ctrlKey)
                                                      : (e) => selection.onCell(row, column.key, e.metaKey || e.ctrlKey)
                                            }
                                            className={[
                                                column.numeric ? "num" : "",
                                                column.className ?? "",
                                                column.cellClassName?.(row) ?? "",
                                                isRowNumber
                                                    ? rowSelected
                                                        ? "selected"
                                                        : ""
                                                    : selection?.isCellSelected(row, column.key)
                                                      ? "selected"
                                                      : "",
                                            ]
                                                .filter(Boolean)
                                                .join(" ")}
                                        >
                                            {column.render(row)}
                                        </td>
                                    );
                                })}
                            </tr>
                        );
                    })}
                    {sorted.length === 0 && (
                        <tr className="norows">
                            <td colSpan={columns.length} className="empty-note">
                                The query returned no rows.
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
}

// The info card is positioned against the viewport, not the header, because the table sits in a
// container that clips its overflow (it has to, for horizontal scrolling) and a card anchored
// inside it was cut off at the container's edge. Fixed positioning escapes that clip; the
// coordinates have to come from JS, and they are written as custom properties on the header so
// the card inherits them without React re-rendering on hover.
const CARD_WIDTH = 320;

function placeInfoCard(event: MouseEvent<HTMLTableCellElement>): void {
    const th = event.currentTarget;
    const box = th.getBoundingClientRect();
    // Keep the card on screen when the header is close to the right edge.
    const left = Math.max(8, Math.min(box.left, window.innerWidth - CARD_WIDTH - 12));
    th.style.setProperty("--tip-x", `${Math.round(left)}px`);
    th.style.setProperty("--tip-y", `${Math.round(box.bottom + 2)}px`);
}

// null/undefined always sort last; empty values never come first, whichever direction is chosen.
function compare(a: SortValue, b: SortValue): number {
    const aEmpty = a === null || a === undefined || a === "";
    const bEmpty = b === null || b === undefined || b === "";
    if (aEmpty || bEmpty) {
        return aEmpty && bEmpty ? 0 : aEmpty ? 1 : -1;
    }
    if (typeof a === "number" && typeof b === "number") {
        return a - b;
    }
    if (typeof a === "boolean" && typeof b === "boolean") {
        return Number(a) - Number(b);
    }
    return String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });
}
