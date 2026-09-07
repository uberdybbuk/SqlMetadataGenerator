import {
    type MouseEvent,
    type ReactNode,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";

import { buildHtml, buildPlainText, type CopyRegion } from "./clipboard";

// The one grid in the app. Sorting, column widths and selection all live here, so that a header
// click means the same thing whether you are looking at a query result, a column list or a table
// list — there is no second behaviour to opt into, and therefore none to drift apart from.
//
// Selection works as it does in SSMS: the row-number gutter down the left edge selects rows, the
// header name selects the column, the corner cell selects everything, and Ctrl/Cmd+C copies the
// selection as text and as HTML. Sorting has its own arrow button, shown under the pointer.
export type SortValue = string | number | boolean | null;

export interface Column<T> {
    key: string;
    header: ReactNode;
    // The plain-text header, for the clipboard. Only needed when the header is not a string.
    title?: string;
    // The card that opens on hovering the header. Secondary information such as the type lives
    // here: written into the header row it widened the column for no good reason.
    info?: ReactNode;
    // Numeric columns are right-aligned and sort descending on the first click.
    numeric?: boolean;
    // The raw value used for sorting. Without it the column cannot be sorted.
    sortValue?: (row: T) => SortValue;
    // The raw value that goes on the clipboard. Defaults to sortValue, which in every table here
    // is already the column's underlying value rather than the decorated cell.
    copyValue?: (row: T) => SortValue;
    // The SQL type name, so a pasted cell reads the way it does on screen (dates lose ISO's 'T')
    // and Excel is told what it is holding. See clipboard.ts.
    copyType?: string;
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
    // What the table says when it has no rows. The wording belongs to the caller: "no rows" from
    // a query and "nothing matched your search" are different facts.
    emptyNote?: string;
}

const MIN_WIDTH = 56;
const GUTTER = "__rownum";

interface Selection {
    // Row keys, not indexes: sorting moves rows around and a selection must survive that.
    rows: Set<string>;
    cols: Set<string>;
    // "rowKey:columnKey"
    cells: Set<string>;
    all: boolean;
}

const NO_SELECTION: Selection = { rows: new Set(), cols: new Set(), cells: new Set(), all: false };

const cellKey = (row: string, column: string) => `${row}:${column}`;

export function DataTable<T>({
    columns,
    rows,
    rowKey,
    initialSort,
    limit,
    dense,
    resizable,
    maxWidth = 320,
    emptyNote = "No rows.",
}: DataTableProps<T>) {
    const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(
        initialSort ? { key: initialSort.key, desc: initialSort.desc ?? false } : null,
    );
    const [widths, setWidths] = useState<Record<string, number> | null>(null);
    const [selection, setSelection] = useState<Selection>(NO_SELECTION);
    const tableRef = useRef<HTMLTableElement>(null);

    const columnKeys = columns.map((c) => c.key).join("|");

    // A new set of rows or columns is a new table; the old selection points at nothing.
    useEffect(() => setSelection(NO_SELECTION), [rows, columnKeys]);

    // Every kind of selection clears the others: clicking a cell drops the previous row,
    // column or select-all, and that cell becomes the active selection.
    const selectRow = useCallback((key: string, additive: boolean) => {
        setSelection((current) => {
            const next = additive && !current.all ? new Set(current.rows) : new Set<string>();
            toggle(next, key);
            return { rows: next, cols: new Set(), cells: new Set(), all: false };
        });
    }, []);

    const selectColumn = useCallback((key: string, additive: boolean) => {
        setSelection((current) => {
            const next = additive && !current.all ? new Set(current.cols) : new Set<string>();
            toggle(next, key);
            return { rows: new Set(), cols: next, cells: new Set(), all: false };
        });
    }, []);

    const selectCell = useCallback((row: string, key: string, additive: boolean) => {
        setSelection((current) => {
            const next = additive && !current.all ? new Set(current.cells) : new Set<string>();
            toggle(next, cellKey(row, key));
            return { rows: new Set(), cols: new Set(), cells: next, all: false };
        });
    }, []);

    const selectAll = useCallback(() => {
        setSelection((current) =>
            current.all ? NO_SELECTION : { rows: new Set(), cols: new Set(), cells: new Set(), all: true },
        );
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

    // The row number is the position in what is ON SCREEN, so it still reads 1..n after a sort.
    const position = useMemo(() => {
        const map = new Map<string, number>();
        sorted.forEach((row, i) => map.set(rowKey(row), i + 1));
        return map;
    }, [sorted, rowKey]);

    const gutter: Column<T> = {
        key: GUTTER,
        // The button covers the whole cell, so nobody has to hit a tiny glyph.
        header: (
            <>
                <button type="button" className="corner" onClick={selectAll} aria-label="Select all">
                    ◧
                </button>
                <span className="colinfo">
                    <span className="card">
                        <b>Select all</b>
                        <span className="muted">
                            Selects every row and column. Ctrl/Cmd+C copies the selection as
                            tab-separated text.
                        </span>
                    </span>
                </span>
            </>
        ),
        render: (row) => position.get(rowKey(row)) ?? 0,
        className: "rownum",
        plain: true,
    };

    const allColumns = [gutter, ...columns];

    // A selection is only useful if it can be copied. Two flavours go on the clipboard at once:
    // plain text (editor/terminal) and HTML (Excel — see clipboard.ts).
    useEffect(() => {
        function onCopy(event: ClipboardEvent) {
            const region = buildRegion(selection, columns, sorted, rowKey);
            // A real text selection on the page wins: the user dragged over something and means
            // that, not the grid's block selection.
            if (!region || window.getSelection()?.toString()) {
                return;
            }

            event.clipboardData?.setData("text/plain", buildPlainText(region));
            event.clipboardData?.setData("text/html", buildHtml(region));
            event.preventDefault();
        }

        document.addEventListener("copy", onCopy);
        return () => document.removeEventListener("copy", onCopy);
    }, [selection, columns, sorted, rowKey]);

    // The widths are measured from the browser's automatic layout and then frozen. Otherwise
    // table-layout:fixed would kick in from the start and give every column the same width.
    useLayoutEffect(() => {
        if (!resizable || widths || !tableRef.current) {
            return;
        }
        const cells = tableRef.current.querySelectorAll("thead th");
        const measured: Record<string, number> = {};
        cells.forEach((cell, i) => {
            const column = allColumns[i];
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
        // columnKeys, not allColumns: the column array is rebuilt on every render, and what
        // actually invalidates a measurement is the SET of columns changing.
    }, [resizable, widths, columnKeys, maxWidth]);

    // When the columns change (moving to another table) the measurement has to reset.
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

    function toggleSort(column: Column<T>) {
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
                        {allColumns.map((c) => (
                            <col key={c.key} style={c.plain ? undefined : { width: widths![c.key] }} />
                        ))}
                    </colgroup>
                )}
                <thead>
                    <tr>
                        {allColumns.map((column) => {
                            const active = sort?.key === column.key;
                            const arrow = active ? (sort!.desc ? "↓" : "↑") : "⇅";
                            const selected = selection.all || selection.cols.has(column.key);
                            return (
                                <th
                                    key={column.key}
                                    className={[
                                        column.numeric ? "num" : "",
                                        column.key === GUTTER ? "rownum-head" : "",
                                        selected ? "selected" : "",
                                    ]
                                        .filter(Boolean)
                                        .join(" ")}
                                    aria-sort={active ? (sort!.desc ? "descending" : "ascending") : undefined}
                                    // Attached unconditionally: the card can come from the column's
                                    // info OR be baked into a plain header (the corner cell), and a
                                    // card with no coordinates lands in the top-left of the page.
                                    onMouseEnter={placeInfoCard}
                                >
                                    {column.plain ? (
                                        column.header
                                    ) : (
                                        // The name selects and the arrow sorts: two separate buttons.
                                        <span className={column.sortValue ? "sort sortable" : "sort"}>
                                            <button
                                                type="button"
                                                className="hname pick"
                                                onClick={(e) => selectColumn(column.key, e.metaKey || e.ctrlKey)}
                                            >
                                                {column.header}
                                            </button>
                                            {column.sortValue && (
                                                <button
                                                    type="button"
                                                    className={active ? "arrow sortbtn active" : "arrow sortbtn"}
                                                    onClick={() => toggleSort(column)}
                                                    aria-label="Sort"
                                                >
                                                    {arrow}
                                                </button>
                                            )}
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
                        const key = rowKey(row);
                        const rowSelected = selection.all || selection.rows.has(key);
                        return (
                            <tr key={key} className={rowSelected ? "selected" : undefined}>
                                {allColumns.map((column) => {
                                    const isGutter = column.key === GUTTER;
                                    return (
                                        <td
                                            key={column.key}
                                            onClick={
                                                isGutter
                                                    ? (e) => selectRow(key, e.metaKey || e.ctrlKey)
                                                    : (e) => selectCell(key, column.key, e.metaKey || e.ctrlKey)
                                            }
                                            className={[
                                                column.numeric ? "num" : "",
                                                column.className ?? "",
                                                column.cellClassName?.(row) ?? "",
                                                isGutter
                                                    ? rowSelected
                                                        ? "selected"
                                                        : ""
                                                    : isCellSelected(selection, key, column.key)
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
                            <td colSpan={allColumns.length} className="empty-note">
                                {emptyNote}
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
}

function toggle<T>(set: Set<T>, value: T): void {
    if (set.has(value)) {
        set.delete(value);
    } else {
        set.add(value);
    }
}

function isCellSelected(selection: Selection, row: string, column: string): boolean {
    return (
        selection.all ||
        selection.rows.has(row) ||
        selection.cols.has(column) ||
        selection.cells.has(cellKey(row, column))
    );
}

// The clipboard sees the column's underlying value, not its rendered cell: a <Link> or a pill is
// a way of showing a name, and what belongs in a spreadsheet is the name.
function copyValueOf<T>(column: Column<T>, row: T): SortValue {
    const read = column.copyValue ?? column.sortValue;
    return read ? read(row) : null;
}

function copyHeaderOf<T>(column: Column<T>): { name: string; typeName: string } {
    return {
        name: column.title ?? (typeof column.header === "string" ? column.header : column.key),
        // A numeric column with no declared type still copies as a number where Excel can hold it
        // losslessly; everything else travels as text, which is the safe default.
        typeName: column.copyType ?? (column.numeric ? "float" : ""),
    };
}

// Turns the selection into a copyable rectangle. With individual cells selected no header is
// written; with a row, column or select-all it is, because otherwise what the pasted columns
// are gets lost.
function buildRegion<T>(
    selection: Selection,
    columns: Column<T>[],
    rows: T[],
    rowKey: (row: T) => string,
): CopyRegion | null {
    const head = columns.map(copyHeaderOf);
    const valuesOf = (row: T, picked: Column<T>[]) => picked.map((c) => copyValueOf(c, row));

    if (selection.all) {
        return { columns: head, rows: rows.map((r) => valuesOf(r, columns)), includeHeader: true };
    }

    if (selection.cols.size > 0) {
        const picked = columns.filter((c) => selection.cols.has(c.key));
        return {
            columns: picked.map(copyHeaderOf),
            rows: rows.map((r) => valuesOf(r, picked)),
            includeHeader: true,
        };
    }

    if (selection.rows.size > 0) {
        return {
            columns: head,
            rows: rows.filter((r) => selection.rows.has(rowKey(r))).map((r) => valuesOf(r, columns)),
            includeHeader: true,
        };
    }

    if (selection.cells.size > 0) {
        // The smallest rectangle covering the selected cells: the row and column alignment is
        // preserved so the shape survives a paste into Excel.
        const usedColumns = columns.filter((c) =>
            rows.some((r) => selection.cells.has(cellKey(rowKey(r), c.key))),
        );
        const usedRows = rows.filter((r) =>
            usedColumns.some((c) => selection.cells.has(cellKey(rowKey(r), c.key))),
        );
        return {
            columns: usedColumns.map(copyHeaderOf),
            rows: usedRows.map((r) =>
                usedColumns.map((c) =>
                    selection.cells.has(cellKey(rowKey(r), c.key)) ? copyValueOf(c, r) : null,
                ),
            ),
            includeHeader: usedColumns.length > 1 || usedRows.length > 1,
        };
    }

    return null;
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
