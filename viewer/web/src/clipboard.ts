import { formatCellText } from "./cell";

// Pasting into Excel.
//
// Plain text (TSV) is not enough on its own: Excel INTERPRETS every cell by its own
// rules and silently corrupts it.
//   - "2026-03-15 06:53:51.7400000" turns into a different date depending on the locale, or
//     loses its sub-second part; in a Turkish Excel it shows up as "15.03.2026".
//   - Codes like "00123" lose their leading zeros.
//   - A bigint of 16+ digits falls back to scientific notation and its VALUE changes.
//
// The fix: a text/html flavour is put on the clipboard as well. Excel prefers HTML and
// honours the cell format given by mso-number-format. By default every cell is marked as
// TEXT ('\@') — what you see on screen is what reaches Excel.
// Only numbers Excel can hold losslessly travel as real numbers.

const TEXT_FORMAT = String.raw`mso-number-format:'\@'`;

// Excel holds double-precision numbers: anything past 15 significant digits is corrupted.
const MAX_SAFE_DIGITS = 15;

const NUMERIC_TYPES = new Set([
    "int", "smallint", "tinyint", "decimal", "numeric", "float", "real", "money", "smallmoney",
]);

// bigint is deliberately off the list: identity values can exceed 15 digits, and past that
// Excel rounds the number. Sending them as text is safer.
function isSafeNumber(value: string | number | boolean | null, typeName: string): boolean {
    if (value === null || typeof value === "boolean") {
        return false;
    }
    if (!NUMERIC_TYPES.has(typeName.toLowerCase())) {
        return false;
    }
    const digits = String(value).replace(/[^0-9]/g, "");
    return digits.length > 0 && digits.length <= MAX_SAFE_DIGITS;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// Only the two things a paste needs to know about a column: what to call it, and what it holds.
// Any grid column can describe itself this way, which is why the region is not tied to a query
// result — the metadata tables copy through the same path.
export interface CopyColumn {
    name: string;
    typeName: string;
}

export interface CopyRegion {
    columns: CopyColumn[];
    // The values per row, in the same order as columns.
    rows: (string | number | boolean | null)[][];
    includeHeader: boolean;
}

// What is on screen also goes to the clipboard, so the user never sees one date and pastes
// another. NULL is written out explicitly — in Excel an empty cell and "no value" are not
// the same thing.
function asText(value: string | number | boolean | null, typeName: string): string {
    return formatCellText(value, typeName);
}

export function buildPlainText({ columns, rows, includeHeader }: CopyRegion): string {
    const lines = rows.map((row) => row.map((v, i) => asText(v, columns[i].typeName)).join("\t"));
    return (includeHeader ? [columns.map((c) => c.name).join("\t"), ...lines] : lines).join("\n");
}

export function buildHtml({ columns, rows, includeHeader }: CopyRegion): string {
    const head = includeHeader
        ? `<tr>${columns.map((c) => `<th>${escapeHtml(c.name)}</th>`).join("")}</tr>`
        : "";

    const body = rows
        .map(
            (row) =>
                `<tr>${row
                    .map((value, i) => {
                        const style = isSafeNumber(value, columns[i].typeName) ? "" : ` style="${TEXT_FORMAT}"`;
                        return `<td${style}>${escapeHtml(asText(value, columns[i].typeName))}</td>`;
                    })
                    .join("")}</tr>`,
        )
        .join("");

    return `<table>${head}${body}</table>`;
}
