import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import { DataTable, type Column } from "./DataTable";
import { formatCell, isNumericType } from "./cell";
import { buildHtml, buildPlainText, type CopyRegion } from "./clipboard";

// The general component for showing a query result. Not just for the table preview: free-form
// queries, WHERE validation and generation reports will all use it later, which is why it knows
// nothing about tables or schemas — only columns, rows, elapsed time and messages.

export interface ResultColumn {
    name: string;
    typeName: string;
    truncated: boolean;
    // Extra information to open on hovering the header; the caller fills it in.
    details?: ReactNode;
}

// Selection works as it does in SSMS: clicking the row number selects the row, clicking the
// header selects the column, and clicking the top-left corner selects everything. Ctrl/Cmd adds.
interface Selection {
    rows: Set<number>;
    cols: Set<string>;
    // "rowIndex:columnKey"
    cells: Set<string>;
    all: boolean;
}

const EMPTY: Selection = { rows: new Set(), cols: new Set(), cells: new Set(), all: false };

const cellKey = (rowIndex: number, columnKey: string) => `${rowIndex}:${columnKey}`;

export interface ResultGridProps {
    columns: ResultColumn[];
    rows: (string | number | boolean | null)[][];
    elapsedMs: number;
    messages: string[];
    // The upper bound to display when the row count is limited (e.g. TOP 20).
    limitNote?: string;
}

interface GridRow {
    index: number;
    values: (string | number | boolean | null)[];
}

export function ResultGrid({ columns, rows, elapsedMs, messages, limitNote }: ResultGridProps) {
    const [tab, setTab] = useState<"results" | "messages">("results");
    const [selection, setSelection] = useState<Selection>(EMPTY);

    // When a new result arrives the old selection has lost its meaning.
    useEffect(() => setSelection(EMPTY), [rows, columns]);

    const gridRows: GridRow[] = useMemo(
        () => rows.map((values, index) => ({ index, values })),
        [rows],
    );

    const columnKeys = useMemo(() => columns.map((c, i) => `${i}-${c.name}`), [columns]);

    // Every kind of selection clears the others: clicking a cell drops the previous row,
    // column or select-all, and that cell becomes the active selection.
    const selectRow = useCallback((row: GridRow, additive: boolean) => {
        setSelection((current) => {
            const next = additive && !current.all ? new Set(current.rows) : new Set<number>();
            toggle(next, row.index);
            return { ...EMPTY, rows: next, cells: new Set() };
        });
    }, []);

    const selectColumn = useCallback((key: string, additive: boolean) => {
        setSelection((current) => {
            const next = additive && !current.all ? new Set(current.cols) : new Set<string>();
            toggle(next, key);
            return { ...EMPTY, cols: next, cells: new Set() };
        });
    }, []);

    const selectCell = useCallback((row: GridRow, key: string, additive: boolean) => {
        setSelection((current) => {
            const next = additive && !current.all ? new Set(current.cells) : new Set<string>();
            toggle(next, cellKey(row.index, key));
            return { ...EMPTY, cells: next, rows: new Set(), cols: new Set() };
        });
    }, []);

    const selectAll = useCallback(() => {
        setSelection((current) => (current.all ? EMPTY : { ...EMPTY, all: true, cells: new Set() }));
    }, []);

    // A selection is only useful if it can be copied. Two flavours go on the clipboard at once:
    // plain text (editor/terminal) and HTML (Excel — see clipboard.ts).
    useEffect(() => {
        function onCopy(event: ClipboardEvent) {
            const region = buildRegion(selection, columns, columnKeys, gridRows);
            if (!region || window.getSelection()?.toString()) {
                return;
            }

            event.clipboardData?.setData("text/plain", buildPlainText(region));
            event.clipboardData?.setData("text/html", buildHtml(region));
            event.preventDefault();
        }

        document.addEventListener("copy", onCopy);
        return () => document.removeEventListener("copy", onCopy);
    }, [selection, columns, columnKeys, gridRows]);

    // The row number down the left edge; the corner cell in its header selects everything.
    const numberColumn: Column<GridRow> = {
        key: "__rownum",
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
        render: (row) => row.index + 1,
        className: "rownum",
        plain: true,
    };

    const dataColumns: Column<GridRow>[] = columns.map((column, i) => ({
        key: columnKeys[i],
        numeric: isNumericType(column.typeName),
        header: column.name,
        info: (
            <span className="card">
                <b className="mono">{column.name}</b>
                <span className="mono muted">{column.typeName}</span>
                {column.details}
                {column.truncated && (
                    <span className="warn-line">
                        Truncated to 256 characters for this preview. Large text and binary values are
                        not transferred in full.
                    </span>
                )}
            </span>
        ),
        sortValue: (row) => row.values[i],
        render: (row) => formatCell(row.values[i], column.typeName),
        className: isNumericType(column.typeName) ? undefined : "mono",
        // The background of a NULL cell is painted, so "no value" is never confused with "empty value".
        cellClassName: (row) => (row.values[i] === null ? "isnull" : undefined),
    }));

    return (
        <div className="result">
            <div className="result-tabs">
                <button className="tab" aria-selected={tab === "results"} onClick={() => setTab("results")}>
                    Results
                </button>
                <button className="tab" aria-selected={tab === "messages"} onClick={() => setTab("messages")}>
                    Messages{messages.length > 0 && <span className="count">{messages.length}</span>}
                </button>
            </div>

            {tab === "results" ? (
                // The headers show even when no rows came back: which columns were queried is
                // information independent of the result being empty.
                <DataTable
                    columns={[numberColumn, ...dataColumns]}
                    rows={gridRows}
                    rowKey={(row) => String(row.index)}
                    dense
                    resizable
                    selection={{
                        isRowSelected: (row) => selection.all || selection.rows.has(row.index),
                        isColumnSelected: (key) => selection.all || selection.cols.has(key),
                        isCellSelected: (row, key) =>
                            selection.all ||
                            selection.rows.has(row.index) ||
                            selection.cols.has(key) ||
                            selection.cells.has(cellKey(row.index, key)),
                        onRow: selectRow,
                        onColumn: selectColumn,
                        onCell: selectCell,
                    }}
                />
            ) : (
                messages.length === 0 ? (
                    <div className="empty-note">The server returned no messages.</div>
                ) : (
                    <div className="messages">
                        {messages.map((message, i) => (
                            <div key={i}>{message}</div>
                        ))}
                    </div>
                )
            )}

            <div className="status">
                <span>
                    {rows.length} {rows.length === 1 ? "row" : "rows"}
                    {limitNote && <span className="muted"> · {limitNote}</span>}
                </span>
                <span>
                    {columns.length} {columns.length === 1 ? "column" : "columns"}
                </span>
                <span className="grow" />
                <span title="Time from sending the command to reading the last row">{elapsedMs} ms</span>
            </div>
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

// Turns the selection into a copyable rectangle. With individual cells selected no header is
// written; with a row, column or select-all it is, because otherwise what the pasted columns
// are gets lost.
function buildRegion(
    selection: Selection,
    columns: ResultColumn[],
    columnKeys: string[],
    gridRows: GridRow[],
): CopyRegion | null {
    if (selection.all) {
        return { columns, rows: gridRows.map((r) => r.values), includeHeader: true };
    }

    if (selection.cols.size > 0) {
        const picked = columns.map((c, i) => ({ c, i })).filter(({ i }) => selection.cols.has(columnKeys[i]));
        return {
            columns: picked.map(({ c }) => c),
            rows: gridRows.map((r) => picked.map(({ i }) => r.values[i])),
            includeHeader: true,
        };
    }

    if (selection.rows.size > 0) {
        return {
            columns,
            rows: gridRows.filter((r) => selection.rows.has(r.index)).map((r) => r.values),
            includeHeader: true,
        };
    }

    if (selection.cells.size > 0) {
        // The smallest rectangle covering the selected cells: the row and column alignment is
        // preserved so the shape survives a paste into Excel.
        const usedColumns = columns
            .map((c, i) => ({ c, i }))
            .filter(({ i }) => gridRows.some((r) => selection.cells.has(cellKey(r.index, columnKeys[i]))));
        const usedRows = gridRows.filter((r) =>
            usedColumns.some(({ i }) => selection.cells.has(cellKey(r.index, columnKeys[i]))),
        );
        return {
            columns: usedColumns.map(({ c }) => c),
            rows: usedRows.map((r) =>
                usedColumns.map(({ i }) =>
                    selection.cells.has(cellKey(r.index, columnKeys[i])) ? r.values[i] : null,
                ),
            ),
            includeHeader: usedColumns.length > 1 || usedRows.length > 1,
        };
    }

    return null;
}
