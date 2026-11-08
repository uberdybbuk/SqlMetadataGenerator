import type { ColumnSummary } from "../api";
import type { Layout } from "./layout";

// A table's pivot definition, kept in this browser across reloads and restarts. Building one
// takes a dozen drags; losing it to a refresh is losing the work.
//
// Only the definition is kept, never the result. The result is table data, which has no
// business sitting in the browser's storage, and it goes out of date anyway. After a reload the
// areas come back filled and one Run (or the auto-run setting) brings the matrix back.

const STORE_KEY = "sqlbrowser.pivots";

// Tables looked at once and never again should not pile up forever: the least recently changed
// definitions go first.
const MAX_TABLES = 50;

export interface Remembered {
    layout: Layout;
    where: string;
    showSql: boolean;
}

type Store = Record<string, Remembered & { at: number }>;

function load(): Store {
    try {
        const parsed = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
        return parsed && typeof parsed === "object" ? (parsed as Store) : {};
    } catch {
        return {};
    }
}

function looksLikeLayout(value: unknown): value is Layout {
    const layout = value as Layout | null;
    return (
        layout !== null &&
        typeof layout === "object" &&
        Array.isArray(layout.filters) &&
        Array.isArray(layout.columns) &&
        Array.isArray(layout.rows) &&
        Array.isArray(layout.values)
    );
}

export function recall(table: string): Remembered | undefined {
    const entry = load()[table];
    if (!entry || !looksLikeLayout(entry.layout)) {
        return undefined;
    }
    return { layout: entry.layout, where: typeof entry.where === "string" ? entry.where : "", showSql: entry.showSql !== false };
}

// An empty definition is forgotten rather than stored: there is nothing in it to come back to.
export function remember(table: string, value: Remembered, empty: boolean): void {
    const store = load();
    if (empty) {
        if (!(table in store)) {
            return;
        }
        delete store[table];
    } else {
        store[table] = { ...value, at: Date.now() };
        const keys = Object.keys(store);
        if (keys.length > MAX_TABLES) {
            keys.sort((a, b) => store[a].at - store[b].at)
                .slice(0, keys.length - MAX_TABLES)
                .forEach((key) => delete store[key]);
        }
    }
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch {
        // Storage is off or full: the definition still lives for this page, as it did before.
    }
}

// A definition saved last week may name a column that has since been dropped or renamed. Such
// fields are left out rather than sent, so the pivot opens with what still exists instead of
// coming back with a server error about a column nobody on screen asked for.
export function fitToColumns(layout: Layout, columns: ColumnSummary[]): Layout {
    if (columns.length === 0) {
        return layout;
    }
    const known = new Set(columns.map((c) => c.name));
    const fits = (column: string | undefined) => column === undefined || known.has(column);
    const filters = layout.filters.filter((f) => fits(f.column));
    const rows = layout.rows.filter((f) => fits(f.column));
    const cols = layout.columns.filter((f) => fits(f.column));
    const values = layout.values.filter((v) => fits(v.column));
    const same =
        filters.length === layout.filters.length &&
        rows.length === layout.rows.length &&
        cols.length === layout.columns.length &&
        values.length === layout.values.length;
    return same ? layout : { filters, rows, columns: cols, values };
}
