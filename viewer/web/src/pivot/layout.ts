import type { ColumnSummary, PivotAgg, PivotFilterField, PivotOp, PivotRowField, PivotSpec, PivotValueField } from "../api";
import { isNumericType } from "../cell";

// What the four areas hold, and the rules for moving a field between them.

export type Area = "filters" | "columns" | "rows" | "values";

// A filter's state as the screen keeps it. "all" is an untouched filter: the field sits in the
// area but excludes nothing.
export interface FilterState {
    column: string;
    mode: "all" | "include" | "exclude";
    values: (string | null)[];
}

// A Rows or Columns field as the screen keeps it. Its sort and value filter name a measure by
// what it IS (measureKey), not by its position in Values: removing or reordering a value would
// otherwise silently point them at another one. A measure that is gone simply stops applying.
export interface LayoutField {
    column: string;
    grain?: PivotRowField["grain"];
    // A measure key, or undefined for the labels.
    sortBy?: string;
    sortDesc?: boolean;
    keep?: { measure: string; op: PivotOp; value: number };
}

export interface Layout {
    filters: FilterState[];
    columns: LayoutField[];
    rows: LayoutField[];
    values: PivotValueField[];
}

export const measureKey = (value: PivotValueField) => `${value.agg}:${value.column ?? ""}`;

export const OPERATORS: { value: PivotOp; label: string }[] = [
    { value: "gt", label: ">" },
    { value: "ge", label: "≥" },
    { value: "lt", label: "<" },
    { value: "le", label: "≤" },
    { value: "eq", label: "=" },
    { value: "ne", label: "≠" },
];

// Whether a measure is a number, which a value filter needs. MIN and MAX keep their column's
// type, so they qualify only over a numeric column.
export function isNumericMeasure(value: PivotValueField, columns: ColumnSummary[]): boolean {
    if (value.agg !== "min" && value.agg !== "max") {
        return true;
    }
    const column = columns.find((c) => c.name === value.column);
    return column !== undefined && isNumericType(column.typeName);
}

// The sort and filter of a field, in words: "Count > 1 · Count, largest first".
export function describeField(field: LayoutField, values: PivotValueField[]): string {
    const name = (key: string) => {
        const value = values.find((v) => measureKey(v) === key);
        return value ? measureLabel(value) : null;
    };
    const parts: string[] = [];
    if (field.keep && name(field.keep.measure)) {
        const op = OPERATORS.find((o) => o.value === field.keep!.op)!.label;
        parts.push(`${name(field.keep.measure)} ${op} ${field.keep.value.toLocaleString("en-US")}`);
    }
    if (field.sortBy && name(field.sortBy)) {
        parts.push(`${name(field.sortBy)}, ${field.sortDesc ? "largest" : "smallest"} first`);
    } else if (!field.sortBy && field.sortDesc) {
        parts.push("Z to A");
    }
    return parts.join(" · ");
}

export const EMPTY_LAYOUT: Layout = { filters: [], columns: [], rows: [], values: [{ agg: "count" }] };

const DATE_TYPES = new Set([
    "date", "datetime", "datetime2", "smalldatetime", "datetimeoffset",
    "timestamp", "timestamptz", "timestamp without time zone", "timestamp with time zone",
]);

export const isDate = (typeName: string) => DATE_TYPES.has(typeName.toLowerCase());

// Amounts rather than codes. An int column is far more often a status or a key than something to
// add up, so ticking one puts it in Rows; a decimal or a float is a quantity, and goes to Values.
const QUANTITY_TYPES = new Set([
    "decimal", "numeric", "money", "smallmoney", "float", "real", "double precision", "float8", "float4",
]);

export const AGGREGATES: { value: PivotAgg; label: (column?: string) => string; numericOnly: boolean }[] = [
    { value: "count", label: () => "Count", numericOnly: false },
    { value: "sum", label: (c) => `Sum of ${c}`, numericOnly: true },
    { value: "avg", label: (c) => `Average of ${c}`, numericOnly: true },
    { value: "min", label: (c) => `Min of ${c}`, numericOnly: false },
    { value: "max", label: (c) => `Max of ${c}`, numericOnly: false },
    { value: "countDistinct", label: (c) => `Distinct ${c}`, numericOnly: false },
];

export function measureLabel(value: PivotValueField): string {
    return AGGREGATES.find((a) => a.value === value.agg)!.label(value.column);
}

// Grouping a timestamp as it stands gives one group per microsecond, so a date field always
// carries a period. Month is the one people mean most often.
function asField(column: ColumnSummary): LayoutField {
    return { column: column.name, grain: isDate(column.typeName) ? "month" : undefined };
}

function asMeasure(column: ColumnSummary): PivotValueField {
    return { agg: isNumericType(column.typeName) ? "sum" : "countDistinct", column: column.name };
}

export function usedColumns(layout: Layout): Set<string> {
    return new Set([
        ...layout.filters.map((f) => f.column),
        ...layout.columns.map((f) => f.column),
        ...layout.rows.map((f) => f.column),
        ...layout.values.flatMap((v) => (v.column ? [v.column] : [])),
    ]);
}

// Why a field cannot go into an area, or null when it can.
export function refusal(column: ColumnSummary, area: Area): string | null {
    if (area === "filters" && isDate(column.typeName)) {
        return "A date is filtered with the WHERE, not with a value list.";
    }
    return null;
}

// Ticking a field in the list: where Excel would put it.
export function tick(layout: Layout, column: ColumnSummary): Layout {
    return QUANTITY_TYPES.has(column.typeName.toLowerCase())
        ? place(layout, column, "values", layout.values.length)
        : place(layout, column, "rows", layout.rows.length);
}

export function untick(layout: Layout, name: string): Layout {
    return {
        filters: layout.filters.filter((f) => f.column !== name),
        columns: layout.columns.filter((f) => f.column !== name),
        rows: layout.rows.filter((f) => f.column !== name),
        values: layout.values.filter((v) => v.column !== name),
    };
}

// Puts a field into an area at a position. A field lives in at most one of Filters, Columns and
// Rows — grouping by it twice says nothing new — so placing it there takes it out of the other
// two first, keeping its period. Values can hold any field as well, because "Sum of Amount" beside
// "Amount" in Rows is a reasonable thing to ask.
export function place(layout: Layout, column: ColumnSummary, area: Area, index: number): Layout {
    if (refusal(column, area)) {
        return layout;
    }
    if (area === "values") {
        const values = [...layout.values];
        values.splice(index, 0, asMeasure(column));
        return { ...layout, values };
    }

    const previous = [...layout.rows, ...layout.columns].find((f) => f.column === column.name);
    const field = previous ?? asField(column);
    const next: Layout = {
        filters: layout.filters.filter((f) => f.column !== column.name),
        columns: layout.columns.filter((f) => f.column !== column.name),
        rows: layout.rows.filter((f) => f.column !== column.name),
        values: layout.values,
    };
    const at = (list: unknown[]) => Math.min(index, list.length);
    if (area === "filters") {
        const previousFilter = layout.filters.find((f) => f.column === column.name);
        next.filters.splice(at(next.filters), 0, previousFilter ?? { column: column.name, mode: "all", values: [] });
    } else {
        next[area].splice(at(next[area]), 0, field);
    }
    return next;
}

// The index a pill had in its area is no longer right once it has left it: moving the second of
// three Rows to the end of Rows inserts at 3 in a list that has become two long.
export function move(layout: Layout, column: ColumnSummary, from: { area: Area; index: number }, to: Area, index: number): Layout {
    if (from.area === "values") {
        const values = [...layout.values];
        const [moved] = values.splice(from.index, 1);
        if (to === "values") {
            values.splice(from.index < index ? index - 1 : index, 0, moved);
            return { ...layout, values };
        }
        return place({ ...layout, values }, column, to, index);
    }
    if (to === "values") {
        // Out of its grouping area, but any measure already over the same field stays.
        const grouped = untick({ ...layout, values: [] }, column.name);
        return place({ ...grouped, values: layout.values }, column, "values", index);
    }
    const adjusted = from.area === to && from.index < index ? index - 1 : index;
    return place(layout, column, to, adjusted);
}

export function remove(layout: Layout, area: Area, index: number): Layout {
    const next = { ...layout, [area]: (layout[area] as unknown[]).filter((_, i) => i !== index) } as Layout;
    return next;
}

// What the server is sent. An untouched filter is left out: it would only say "everything".
// What the server is sent for a Rows or Columns field: measures by position, as the spec counts
// them. withSort false leaves the sort out, for telling a re-sort apart from a real change.
function wireField(field: LayoutField, values: PivotValueField[], withSort: boolean): PivotRowField {
    const index = (key: string) => values.findIndex((v) => measureKey(v) === key);
    const out: PivotRowField = { column: field.column, grain: field.grain };
    if (withSort && (field.sortBy || field.sortDesc)) {
        const measure = field.sortBy ? index(field.sortBy) : -1;
        if (!field.sortBy || measure >= 0) {
            out.sort = { measure: measure >= 0 ? measure : undefined, descending: field.sortDesc === true };
        }
    }
    if (field.keep && index(field.keep.measure) >= 0) {
        out.filter = { measure: index(field.keep.measure), op: field.keep.op, value: field.keep.value };
    }
    return out;
}

export function toSpec(layout: Layout, where: string, limit: number, withSort = true): PivotSpec {
    const filters: PivotFilterField[] = layout.filters
        .filter((f) => f.mode !== "all")
        .map((f) => ({ column: f.column, values: f.values, exclude: f.mode === "exclude" }));
    return {
        rows: layout.rows.map((f) => wireField(f, layout.values, withSort)),
        columns: layout.columns.map((f) => wireField(f, layout.values, withSort)),
        values: layout.values,
        filters,
        where: where.trim() || undefined,
        totals: true,
        // The group limit is a count of LINES. With column fields every result row is one cell,
        // so the setting would cut a cross-tab short; the server's own cell ceiling applies there.
        limit: layout.columns.length > 0 ? undefined : limit,
    };
}

export function filterSummary(filter: FilterState): string {
    const show = (v: string | null) => (v === null ? "(null)" : v);
    if (filter.mode === "all") {
        return "(all)";
    }
    if (filter.mode === "include") {
        return filter.values.length === 1 ? show(filter.values[0]) : `${filter.values.length} values`;
    }
    return filter.values.length === 1 ? `not ${show(filter.values[0])}` : `not ${filter.values.length} values`;
}
