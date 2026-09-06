// Row counts and sizes come from catalog views; they are approximate, because nothing is
// scanned. The display does not hide that.
export function formatRows(value: number): string {
    return value.toLocaleString("en-US");
}

export function formatKb(kb: number): string {
    if (kb <= 0) {
        return "—";
    }
    if (kb < 1024) {
        return `${kb} KB`;
    }
    const mb = kb / 1024;
    if (mb < 1024) {
        return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
    }
    return `${(mb / 1024).toFixed(1)} GB`;
}

export function formatMb(mb: number): string {
    if (mb <= 0) {
        return "—";
    }
    return mb < 1024 ? `${mb} MB` : `${(mb / 1024).toFixed(1)} GB`;
}

export function formatDate(iso: string): string {
    return iso.slice(0, 10);
}

// Turns a SQL type from the column metadata into something readable (nvarchar(max), decimal(18, 2) ...).
export function formatType(
    typeName: string,
    maxLength: number,
    precision: number,
    scale: number,
): string {
    const t = typeName.toLowerCase();
    if (t === "varchar" || t === "char" || t === "varbinary" || t === "binary") {
        return `${t}(${maxLength === -1 ? "max" : maxLength})`;
    }
    if (t === "nvarchar" || t === "nchar") {
        return `${t}(${maxLength === -1 ? "max" : maxLength / 2})`;
    }
    if (t === "decimal" || t === "numeric") {
        return `${t}(${precision}, ${scale})`;
    }
    if (t === "datetime2" || t === "datetimeoffset" || t === "time") {
        return `${t}(${scale})`;
    }
    return t;
}

// Avoids output like "1 procedures". A second form is supplied for irregular plurals.
export function plural(count: number, singular: string, pluralForm?: string): string {
    return count === 1 ? singular : (pluralForm ?? singular + "s");
}

// SQL Server stores a default constraint already parenthesised, and wraps a scalar once more:
// ((0)) for a number, ('Pending') for a string. The parentheses say nothing about the value, so
// the detail table shows what is inside them. DISPLAY ONLY — the script tab keeps the server's
// exact text, because that is what gets written to a .sql file and rewriting it there would
// change what the generator produces.
//
// Only a pair that actually wraps the whole expression is removed: ((a)+(b)) loses one pair and
// stops, because the leading "(" in the result closes before the end. Quoted text is skipped, so
// a literal like ('a)b') is not miscounted.
export function unwrapDefault(definition: string): string {
    let text = definition.trim();
    while (text.length > 1 && text.startsWith("(") && text.endsWith(")") && wrapsWhole(text)) {
        text = text.slice(1, -1).trim();
    }
    return text;
}

function wrapsWhole(text: string): boolean {
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === "'") {
            i = skipQuoted(text, i);
            continue;
        }
        if (ch === "(") {
            depth++;
        } else if (ch === ")") {
            depth--;
            if (depth === 0) {
                return i === text.length - 1;
            }
        }
    }
    return false;
}

// Called with i on the opening quote; returns the index of the closing one. A doubled quote is an
// escape and does not close the literal.
function skipQuoted(text: string, i: number): number {
    for (let j = i + 1; j < text.length; j++) {
        if (text[j] !== "'") {
            continue;
        }
        if (text[j + 1] === "'") {
            j++;
            continue;
        }
        return j;
    }
    return text.length;
}
