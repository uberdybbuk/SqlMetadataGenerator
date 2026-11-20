import { idOf, type ScriptableObject } from "./selection";

// A pasted list of object names, matched against the inventory.
//
// The list comes from wherever people keep such lists: a ticket, a mail, a column in Excel. So
// ";" and line breaks both separate names, brackets and quotes are taken off, and the schema is
// optional. Matching is case-insensitive, like SQL Server's identifiers.
//
// A name that fits more than one object is NOT ticked. "Orders" in both dbo and sales is a
// question only the person can answer, and ticking both would quietly script one too many.

export interface PasteOutcome {
    // Every distinct name in the paste, in order.
    names: string[];
    // The objects to tick: exactly one match each.
    found: ScriptableObject[];
    notFound: string[];
    ambiguous: string[];
}

export function matchPastedList(text: string, objects: ScriptableObject[]): PasteOutcome {
    const byFull = new Map<string, ScriptableObject[]>();
    const byName = new Map<string, ScriptableObject[]>();
    for (const o of objects) {
        push(byFull, (o.schema + "." + o.name).toLowerCase(), o);
        push(byName, o.name.toLowerCase(), o);
    }

    const outcome: PasteOutcome = { names: [], found: [], notFound: [], ambiguous: [] };
    const seenNames = new Set<string>();
    const seenObjects = new Set<string>();

    for (const raw of text.split(/[;\r\n]+/)) {
        const parts = splitName(raw);
        if (parts.length === 0) {
            continue;
        }

        const display = parts.join(".");
        const key = display.toLowerCase();
        if (seenNames.has(key)) {
            continue;
        }
        seenNames.add(key);

        // db.schema.name: the database part names the one we are already in, or a typo. Either
        // way the last two parts are what identifies the object.
        const hits =
            parts.length === 1
                ? (byName.get(parts[0].toLowerCase()) ?? [])
                : (byFull.get(parts.slice(-2).join(".").toLowerCase()) ?? []);

        if (hits.length === 1 && seenObjects.has(idOf(hits[0]))) {
            // Two spellings of one object ("Customers" and "dbo.Customers") are one name.
            continue;
        }
        outcome.names.push(display);

        if (hits.length === 0) {
            outcome.notFound.push(display);
        } else if (hits.length > 1) {
            outcome.ambiguous.push(display);
        } else {
            seenObjects.add(idOf(hits[0]));
            outcome.found.push(hits[0]);
        }
    }

    return outcome;
}

// "[dbo].[Order Lines]" → ["dbo", "Order Lines"]. A dot inside brackets or quotes is part of the
// name, not a separator.
function splitName(raw: string): string[] {
    const parts: string[] = [];
    let current = "";
    let close: string | null = null;

    for (const ch of raw.trim()) {
        if (close !== null) {
            if (ch === close) {
                close = null;
            } else {
                current += ch;
            }
        } else if (ch === "[") {
            close = "]";
        } else if (ch === '"' || ch === "`") {
            close = ch;
        } else if (ch === ".") {
            parts.push(current.trim());
            current = "";
        } else {
            current += ch;
        }
    }
    parts.push(current.trim());

    return parts.every((p) => p === "") ? [] : parts.filter((p) => p !== "");
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
    const list = map.get(key);
    if (list) {
        list.push(value);
    } else {
        map.set(key, [value]);
    }
}
