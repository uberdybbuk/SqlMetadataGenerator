import type { ReactNode } from "react";

// Formats values according to their SQL type.
//
// The backend sends date and time values as ISO 8601 ("o"), which is right for a machine but
// bad to read on screen: writing "2026-07-22T00:00:00.0000000" in a `date` column says nothing,
// since the time part is zero by definition. The 'T' in the middle is ISO's separator and tells
// a person nothing either.
//
// The sub-second part comes back as its own <span>: the value is shown in full, but the eye
// catches the meaningful part first.

const DATE_ONLY = new Set(["date"]);
const DATE_TIME = new Set(["datetime", "datetime2", "smalldatetime", "datetimeoffset"]);
const TIME_ONLY = new Set(["time"]);

export function formatCell(value: unknown, typeName: string): ReactNode {
    // NULL and an empty string must not look the same on screen: one is "no value", the other
    // is "a value, and it is empty". As in SSMS, NULL is marked with its own colour.
    if (value === null || value === undefined) {
        return <span className="null">NULL</span>;
    }

    const t = typeName.toLowerCase();
    const text = String(value);

    if (text === "") {
        return <span className="empty">empty</span>;
    }

    if (DATE_ONLY.has(t)) {
        // "2026-07-22T00:00:00.0000000" -> "2026-07-22"
        return text.slice(0, 10);
    }

    if (DATE_TIME.has(t)) {
        return splitTimestamp(text);
    }

    if (TIME_ONLY.has(t)) {
        const [main, fraction] = splitFraction(text);
        return (
            <>
                {main}
                {fraction && <span className="sub">{fraction}</span>}
            </>
        );
    }

    return text.length > 300 ? text.slice(0, 300) + "…" : text;
}

// "2026-07-22T20:27:03.1717949" -> "2026-07-22 20:27:03" plus a faint ".1717949"
function splitTimestamp(text: string): ReactNode {
    const t = text.indexOf("T");
    if (t < 0) {
        return text;
    }

    const date = text.slice(0, t);
    const [time, fraction] = splitFraction(text.slice(t + 1));
    return (
        <>
            {date} {time}
            {fraction && <span className="sub">{fraction}</span>}
        </>
    );
}

// Separates the sub-second part and the time-zone suffix, when there is one.
function splitFraction(time: string): [string, string] {
    const dot = time.indexOf(".");
    if (dot < 0) {
        return [time, ""];
    }
    return [time.slice(0, dot), time.slice(dot)];
}

// The plain-text counterpart of formatCell — used when copying to the clipboard.
// It writes what is on screen: the same date format, without ISO's 'T' separator.
// The one difference is the empty string: the screen shows an "empty" label, but EMPTY goes to
// the clipboard, otherwise the word "empty" would be pasted into the cell.
export function formatCellText(value: unknown, typeName: string): string {
    if (value === null || value === undefined) {
        return "NULL";
    }

    const t = typeName.toLowerCase();
    const text = String(value);

    if (DATE_ONLY.has(t)) {
        return text.slice(0, 10);
    }
    if (DATE_TIME.has(t)) {
        return text.replace("T", " ");
    }
    return text;
}

// Numeric types are right-aligned; text and dates go left.
const NUMERIC = new Set([
    "bigint", "int", "smallint", "tinyint", "decimal", "numeric",
    "float", "real", "money", "smallmoney", "bit",
]);

export function isNumericType(typeName: string): boolean {
    return NUMERIC.has(typeName.toLowerCase());
}
