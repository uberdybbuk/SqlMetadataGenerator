import type { PivotAgg, PivotGrain, PivotResult, PivotRowField, PivotValueField } from "../api";

// Folds the server's answer into Excel's matrix.
//
// The server answers in long form: one result row per (row group, column group) pair, with a
// GROUPING flag per field saying which fields were rolled up. Because the grouping sets are
// prefixes, the rolled-up fields are always a suffix: a row whose flags read 0 0 1 is a subtotal
// at the second level. That makes every result row an address — a path down the row tree and a
// path across the column tree — and the matrix is those addresses laid out.

export type Cell = string | number | boolean | null;

export interface ColumnHead {
    key: string;
    // The column field values down to this head. Shorter than the column field count for a
    // subtotal, empty for the grand total.
    path: Cell[];
    kind: "leaf" | "subtotal" | "grand";
}

export interface RowNode {
    key: string;
    path: Cell[];
    // Measure values per column head key.
    values: Map<string, Cell[]>;
    children: RowNode[];
}

export interface Matrix {
    rowFields: PivotRowField[];
    columnFields: PivotRowField[];
    measures: { name: string; typeName: string; agg: PivotAgg }[];
    heads: ColumnHead[];
    // The grand total; its children are the first row field's groups.
    root: RowNode;
    leafRows: number;
    cells: number;
}

// The measures whose share of the grand total means something: the average of the parts is not
// a share of the average of the whole.
export const ADDITIVE = new Set<PivotAgg>(["count", "sum"]);

export const keyOf = (path: Cell[]) => JSON.stringify(path);

export function toMatrix(
    result: PivotResult,
    rowFields: PivotRowField[],
    columnFields: PivotRowField[],
    values: PivotValueField[],
): Matrix {
    const r = result.rowFieldCount;
    const c = result.columnFieldCount ?? 0;
    const m = result.measureCount;
    const levels = r + c + m;

    const root: RowNode = { key: keyOf([]), path: [], values: new Map(), children: [] };
    const nodes = new Map<string, RowNode>([[root.key, root]]);
    const columnPaths = new Map<string, Cell[]>();
    let leafRows = 0;

    const nodeFor = (path: Cell[]): RowNode => {
        const key = keyOf(path);
        let node = nodes.get(key);
        if (!node) {
            const parent = nodeFor(path.slice(0, -1));
            node = { key, path, values: new Map(), children: [] };
            parent.children.push(node);
            nodes.set(key, node);
        }
        return node;
    };

    for (const row of result.rows) {
        const flag = (i: number) => Number(row[levels + i] ?? 0) === 1;
        let rowDepth = r;
        while (rowDepth > 0 && flag(rowDepth - 1)) {
            rowDepth--;
        }
        let colDepth = c;
        while (colDepth > 0 && flag(r + colDepth - 1)) {
            colDepth--;
        }

        const rowPath = row.slice(0, rowDepth);
        const colPath = row.slice(r, r + colDepth);
        const colKey = keyOf(colPath);
        columnPaths.set(colKey, colPath);

        const node = nodeFor(rowPath);
        if (rowDepth === r && node.values.size === 0) {
            leafRows++;
        }
        node.values.set(colKey, row.slice(r + c, r + c + m));
    }

    sortTree(root);

    return {
        rowFields,
        columnFields,
        measures: values.map((value, i) => ({
            name: result.columns[r + c + i]?.name ?? "Value",
            typeName: result.columns[r + c + i]?.typeName ?? "",
            agg: value.agg,
        })),
        heads: orderHeads([...columnPaths.values()], c),
        root,
        leafRows,
        cells: result.rows.length,
    };
}

// Excel's default: labels ascending, blanks last.
export function compareCells(a: Cell, b: Cell): number {
    if (a === b) {
        return 0;
    }
    if (a === null) {
        return 1;
    }
    if (b === null) {
        return -1;
    }
    if (typeof a === "number" && typeof b === "number") {
        return a - b;
    }
    return String(a).localeCompare(String(b), "en", { numeric: true });
}

function sortTree(node: RowNode): void {
    node.children.sort((a, b) => compareCells(a.path[a.path.length - 1], b.path[b.path.length - 1]));
    node.children.forEach(sortTree);
}

// Leaves in label order; with more than one column field, each outer group's subtotal right after
// its members; the grand total last. That is the order Excel lays a column area out in.
function orderHeads(paths: Cell[][], depth: number): ColumnHead[] {
    if (depth === 0) {
        return [{ key: keyOf([]), path: [], kind: "grand" }];
    }

    const present = new Set(paths.map(keyOf));
    const heads: ColumnHead[] = [];
    const walk = (prefix: Cell[]) => {
        const level = prefix.length;
        const children = [
            ...new Map(
                paths
                    .filter((p) => p.length > level && keyOf(p.slice(0, level)) === keyOf(prefix))
                    .map((p) => [keyOf(p.slice(0, level + 1)), p.slice(0, level + 1)] as const),
            ).values(),
        ].sort((a, b) => compareCells(a[level], b[level]));

        for (const child of children) {
            if (child.length === depth) {
                heads.push({ key: keyOf(child), path: child, kind: "leaf" });
            } else {
                walk(child);
                if (present.has(keyOf(child))) {
                    heads.push({ key: keyOf(child), path: child, kind: "subtotal" });
                }
            }
        }
    };
    walk([]);
    if (present.has(keyOf([]))) {
        heads.push({ key: keyOf([]), path: [], kind: "grand" });
    }
    return heads;
}

// The rows on screen: depth first, a collapsed group showing its subtotal but not its members.
// The grand total is not among them; the matrix draws it last, on its own.
export function visibleRows(root: RowNode, collapsed: Set<string>): RowNode[] {
    const out: RowNode[] = [];
    const walk = (node: RowNode) => {
        for (const child of node.children) {
            out.push(child);
            if (!collapsed.has(child.key)) {
                walk(child);
            }
        }
    };
    walk(root);
    return out;
}

// How a group's value reads in a header. A date rolled up to a period is shown as the period, not
// as the first day the server used to stand for it.
export function formatLabel(value: Cell, field: PivotRowField | undefined): string {
    if (value === null) {
        return "(null)";
    }
    const grain: PivotGrain | undefined = field?.grain;
    if (grain && grain !== "none" && typeof value === "string") {
        const year = value.slice(0, 4);
        const month = Number(value.slice(5, 7));
        switch (grain) {
            case "year":
                return year;
            case "quarter":
                return `${year} Q${Math.floor((month - 1) / 3) + 1}`;
            case "month":
                return value.slice(0, 7);
            default:
                return value.slice(0, 10);
        }
    }
    return String(value);
}

export function formatMeasure(value: Cell): string {
    if (value === null) {
        return "";
    }
    if (typeof value === "number") {
        return value.toLocaleString("en-US", { maximumFractionDigits: Number.isInteger(value) ? 0 : 2 });
    }
    // MIN and MAX of a date column come back as ISO text; the 'T' tells a reader nothing.
    return typeof value === "string" ? value.replace(/^(\d{4}-\d{2}-\d{2})T/, "$1 ") : String(value);
}

// Tab-separated, as Excel pastes it: the row labels indented by level, then every value column.
export function toTsv(matrix: Matrix, rows: RowNode[], headers: string[]): string {
    const lines = [headers.join("\t")];
    const line = (label: string, node: RowNode) => {
        const cells = matrix.heads.flatMap((head) =>
            (node.values.get(head.key) ?? matrix.measures.map(() => null)).map((v) =>
                v === null ? "" : String(v),
            ),
        );
        lines.push([label, ...cells].join("\t"));
    };
    for (const node of rows) {
        const depth = node.path.length - 1;
        line("  ".repeat(depth) + formatLabel(node.path[depth], matrix.rowFields[depth]), node);
    }
    line("Grand total", matrix.root);
    return lines.join("\n");
}
