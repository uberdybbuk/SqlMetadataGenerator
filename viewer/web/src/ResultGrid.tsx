import { type ReactNode, useMemo, useState } from "react";

import { DataTable, type Column } from "./DataTable";
import { formatCell, isNumericType } from "./cell";

// The general component for showing a query result. Not just for the table preview: free-form
// queries, WHERE validation and generation reports will all use it later, which is why it knows
// nothing about tables or schemas — only columns, rows, elapsed time and messages.
//
// Selection and copying are NOT here: they belong to DataTable, so that every grid in the app —
// this one, the column list, the object lists — answers a header click the same way.

export interface ResultColumn {
    name: string;
    typeName: string;
    truncated: boolean;
    // Extra information to open on hovering the header; the caller fills it in.
    details?: ReactNode;
}

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

// One field of the result, read down the page instead of across it.
interface FieldRow {
    column: ResultColumn;
    index: number;
    values: (string | number | boolean | null)[];
}

// How many result rows become columns before transposing stops being useful. Past this you are
// scrolling sideways through a wall, which is the problem transposing was meant to solve; the
// status bar says how many are shown so the cut is never silent.
const MAX_TRANSPOSED = 50;

export function ResultGrid({ columns, rows, elapsedMs, messages, limitNote }: ResultGridProps) {
    const [tab, setTab] = useState<"results" | "messages">("results");
    // Transposed: the column names run down the first column and each result row becomes a
    // column of its own. For a wide row — a log table with twenty fields — that is the
    // difference between reading a record and scrolling sideways hunting for it.
    const [transposed, setTransposed] = useState(false);

    const gridRows: GridRow[] = useMemo(
        () => rows.map((values, index) => ({ index, values })),
        [rows],
    );

    const shownRows = Math.min(rows.length, MAX_TRANSPOSED);

    const fieldRows: FieldRow[] = useMemo(
        () => columns.map((column, i) => ({ column, index: i, values: rows.map((row) => row[i]) })),
        [columns, rows],
    );

    // Transposed, a single column holds an int, a date and a string at once, so everything the
    // grid normally decides per column — alignment, how a value is formatted, whether it reads
    // as mono — is decided per ROW here instead, from that row's own type.
    const transposedColumns: Column<FieldRow>[] = useMemo(() => {
        const head: Column<FieldRow> = {
            key: "__field",
            header: "Column",
            className: "mono",
            sortValue: (row) => row.column.name,
            render: (row) => (
                <>
                    {row.column.name}
                    <span className="muted"> {row.column.typeName}</span>
                </>
            ),
        };

        const perRow: Column<FieldRow>[] = Array.from({ length: shownRows }, (_, r) => ({
            key: `row-${r}`,
            header: String(r + 1),
            render: (field) => formatCell(field.values[r], field.column.typeName),
            cellClassName: (field) =>
                [
                    field.values[r] === null ? "isnull" : null,
                    isNumericType(field.column.typeName) ? "num" : "mono",
                ]
                    .filter(Boolean)
                    .join(" ") || undefined,
        }));

        return [head, ...perRow];
    }, [shownRows]);

    const dataColumns: Column<GridRow>[] = columns.map((column, i) => ({
        key: `${i}-${column.name}`,
        numeric: isNumericType(column.typeName),
        header: column.name,
        copyType: column.typeName,
        info: (
            <span className="card">
                <b className="mono">{column.name}</b>
                {/* The type is printed once. A caller that knows more — precision, nullability,
                    key membership — says so in details and owns that line; one that knows only what
                    the reader reported falls back to the bare type name. */}
                {column.details ?? <span className="mono muted">{column.typeName}</span>}
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
                <span className="grow" />
                <button
                    className="tool"
                    aria-pressed={transposed}
                    onClick={() => setTransposed((on) => !on)}
                    disabled={tab !== "results" || rows.length === 0}
                    title="Show the column names down the page and each row as a column"
                >
                    Transpose
                </button>
            </div>

            {tab === "results" ? (
                transposed ? (
                    <DataTable
                        columns={transposedColumns}
                        rows={fieldRows}
                        rowKey={(row) => String(row.index)}
                        dense
                        resizable
                        emptyNote="The query returned no rows."
                    />
                ) : (
                    // The headers show even when no rows came back: which columns were queried is
                    // information independent of the result being empty.
                    <DataTable
                        columns={dataColumns}
                        rows={gridRows}
                        rowKey={(row) => String(row.index)}
                        dense
                        resizable
                        emptyNote="The query returned no rows."
                    />
                )
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
                {transposed && shownRows < rows.length && (
                    <span className="muted">transposed: first {shownRows} rows</span>
                )}
                <span className="grow" />
                <span title="Time from sending the command to reading the last row">{elapsedMs} ms</span>
            </div>
        </div>
    );
}
