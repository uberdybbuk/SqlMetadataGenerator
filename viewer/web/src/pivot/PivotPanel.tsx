import { useMemo, useState } from "react";

import {
    api,
    type ColumnSummary,
    type PivotAgg,
    type PivotGrain,
    type PivotResult,
    type PivotRowField,
    type PivotValueField,
} from "../api";
import { useApi } from "../useApi";
import { Icon } from "../Icon";
import { ResultGrid, type ResultColumn } from "../ResultGrid";
import { isNumericType } from "../cell";

// Analysing a table by grouping it.
//
// The aggregation happens in the DATABASE, not over the rows on screen. The grid holds at most a
// thousand rows because the server caps it there, and a total computed from a capped sample is a
// wrong number presented with complete confidence — the one thing an analysis screen must never
// produce. What travels to the server is a spec; what comes back is the summary and the exact
// statement that produced it.

const AGGREGATES: { value: PivotAgg; label: string; needsColumn: boolean; numericOnly: boolean }[] = [
    { value: "count", label: "count rows", needsColumn: false, numericOnly: false },
    { value: "sum", label: "sum", needsColumn: true, numericOnly: true },
    { value: "avg", label: "average", needsColumn: true, numericOnly: true },
    { value: "min", label: "min", needsColumn: true, numericOnly: false },
    { value: "max", label: "max", needsColumn: true, numericOnly: false },
    { value: "countDistinct", label: "distinct values", needsColumn: true, numericOnly: false },
];

const GRAINS: PivotGrain[] = ["year", "quarter", "month", "day"];

// Grouping a timestamp as it stands gives one group per microsecond, so a date field always
// carries a period. Month is the one people mean most often.
const DATE_TYPES = new Set([
    "date", "datetime", "datetime2", "smalldatetime", "datetimeoffset",
    "timestamp", "timestamptz", "timestamp without time zone", "timestamp with time zone",
]);

const isDate = (typeName: string) => DATE_TYPES.has(typeName.toLowerCase());

// A share of the total only means something for a measure that adds up. The average of the parts
// is not a share of the average of the whole, so those columns simply do not get one.
const ADDITIVE = new Set<PivotAgg>(["count", "sum"]);

export function PivotPanel({ alias, db, schema, name }: { alias: string; db: string; schema: string; name: string }) {
    const shape = useApi(() => api.table(alias, db, schema, name), [alias, db, schema, name]);
    const columns: ColumnSummary[] = useMemo(() => shape.data?.columns ?? [], [shape.data]);

    const [rows, setRows] = useState<PivotRowField[]>([]);
    const [values, setValues] = useState<PivotValueField[]>([{ agg: "count" }]);
    const [where, setWhere] = useState("");
    const [result, setResult] = useState<PivotResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [running, setRunning] = useState(false);
    const [showSql, setShowSql] = useState(false);

    const addRow = () => {
        const used = new Set(rows.map((r) => r.column));
        const next = columns.find((c) => !used.has(c.name));
        if (next) {
            setRows([...rows, { column: next.name, grain: isDate(next.typeName) ? "month" : undefined }]);
        }
    };

    const run = async () => {
        setRunning(true);
        setError(null);
        try {
            setResult(
                await api.pivot(alias, db, schema, name, {
                    rows,
                    values,
                    where: where.trim() || undefined,
                    totals: true,
                }),
            );
        } catch (err) {
            setResult(null);
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setRunning(false);
        }
    };

    const view = useMemo(() => (result ? toGrid(result, values) : null), [result, values]);

    if (shape.loading) {
        return <div className="state">Reading the columns…</div>;
    }
    if (shape.error) {
        return <div className="error">{shape.error}</div>;
    }

    return (
        <div className="pivot">
            <div className="pivot-spec">
                <div className="pivot-group">
                    <span className="pivot-label">Group by</span>
                    {rows.map((row, i) => (
                        <span className="pivot-field" key={i}>
                            <select
                                value={row.column}
                                onChange={(e) => {
                                    const column = columns.find((c) => c.name === e.target.value);
                                    setRows(rows.map((r, j) => (j === i
                                        ? { column: e.target.value, grain: column && isDate(column.typeName) ? (r.grain ?? "month") : undefined }
                                        : r)));
                                }}
                            >
                                {columns.map((c) => (
                                    <option key={c.name} value={c.name}>{c.name}</option>
                                ))}
                            </select>
                            {row.grain && (
                                <select
                                    value={row.grain}
                                    onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, grain: e.target.value as PivotGrain } : r)))}
                                >
                                    {GRAINS.map((g) => <option key={g} value={g}>by {g}</option>)}
                                </select>
                            )}
                            <button className="pivot-x" onClick={() => setRows(rows.filter((_, j) => j !== i))} title="Remove">
                                ×
                            </button>
                        </span>
                    ))}
                    <button className="tool" onClick={addRow} disabled={rows.length >= columns.length}>
                        <Icon name="plus" size={13} />
                        field
                    </button>
                </div>

                <div className="pivot-group">
                    <span className="pivot-label">Measure</span>
                    {values.map((value, i) => {
                        const spec = AGGREGATES.find((a) => a.value === value.agg)!;
                        const candidates = columns.filter((c) => !spec.numericOnly || isNumericType(c.typeName));
                        return (
                            <span className="pivot-field" key={i}>
                                <select
                                    value={value.agg}
                                    onChange={(e) => {
                                        const agg = e.target.value as PivotAgg;
                                        const next = AGGREGATES.find((a) => a.value === agg)!;
                                        const pool = columns.filter((c) => !next.numericOnly || isNumericType(c.typeName));
                                        setValues(values.map((v, j) => (j === i
                                            ? { agg, column: next.needsColumn ? (pool.some((c) => c.name === v.column) ? v.column : pool[0]?.name) : undefined }
                                            : v)));
                                    }}
                                >
                                    {AGGREGATES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                                </select>
                                {spec.needsColumn && (
                                    <select
                                        value={value.column ?? ""}
                                        onChange={(e) => setValues(values.map((v, j) => (j === i ? { ...v, column: e.target.value } : v)))}
                                    >
                                        {candidates.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                                    </select>
                                )}
                                {values.length > 1 && (
                                    <button className="pivot-x" onClick={() => setValues(values.filter((_, j) => j !== i))} title="Remove">
                                        ×
                                    </button>
                                )}
                            </span>
                        );
                    })}
                    <button className="tool" onClick={() => setValues([...values, { agg: "count" }])}>
                        <Icon name="plus" size={13} />
                        measure
                    </button>
                </div>

                <div className="pivot-group grow">
                    <span className="pivot-label">Where</span>
                    <input
                        className="mono pivot-where"
                        value={where}
                        placeholder="optional — e.g. CreatedAt >= '2026-01-01'"
                        onChange={(e) => setWhere(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && rows.length > 0 && run()}
                    />
                </div>

                <button className="tool run" onClick={run} disabled={running || rows.length === 0 || values.length === 0}>
                    <Icon name="play" size={14} />
                    {running ? "Running…" : "Run"}
                </button>
            </div>

            {rows.length === 0 && !error && (
                <div className="panel-empty">
                    <b>Pick a field to group by</b>
                    Every figure is computed by the database over the whole table, not over the rows on screen.
                </div>
            )}

            {error && <div className="error">{error}</div>}

            {view && (
                <>
                    <ResultGrid
                        columns={view.columns}
                        rows={view.rows}
                        elapsedMs={result!.elapsedMs}
                        messages={[]}
                        limitNote={result!.capped ? `stopped at ${result!.rows.length} groups` : undefined}
                    />
                    <div className="pivot-sql">
                        <button className="tool" onClick={() => setShowSql((on) => !on)}>
                            {showSql ? "Hide SQL" : "Show SQL"}
                        </button>
                        {showSql && <pre className="mono">{result!.sql}</pre>}
                    </div>
                </>
            )}
        </div>
    );
}

// Turns the server's answer into what the grid shows: the GROUPING flags become readable total
// labels, the rows are put back in the order a reader expects, and every additive measure gains
// its share of the grand total.
function toGrid(result: PivotResult, values: PivotValueField[]) {
    const fields = result.rowFieldCount;
    const measures = result.measureCount;
    const levelAt = fields + measures;

    // How many fields were rolled up: 0 is a leaf, everything else is a subtotal, and all of them
    // is the grand total.
    const depth = (row: (string | number | boolean | null)[]) =>
        Array.from({ length: fields }, (_, i) => Number(row[levelAt + i] ?? 0)).reduce((a, b) => a + b, 0);

    const grand = result.rows.find((row) => depth(row) === fields);

    // Leaves first, subtotals under them, the grand total last — the arrangement Excel uses. The
    // server sends totals FIRST so the row cap can never drop them; the order is a display choice.
    const ordered = [...result.rows].sort((a, b) => depth(a) - depth(b));

    const columns: ResultColumn[] = [];
    for (let i = 0; i < fields; i++) {
        columns.push({ name: result.columns[i].name, typeName: result.columns[i].typeName, truncated: false });
    }
    for (let m = 0; m < measures; m++) {
        const source = result.columns[fields + m];
        columns.push({ name: source.name, typeName: source.typeName, truncated: false });
        if (ADDITIVE.has(values[m]?.agg ?? "count") && grand) {
            columns.push({ name: "% of total", typeName: "float", truncated: false });
        }
    }

    const rows = ordered.map((row) => {
        const rolled = depth(row);
        const out: (string | number | boolean | null)[] = [];
        for (let i = 0; i < fields; i++) {
            const isRolled = Number(row[levelAt + i] ?? 0) === 1;
            out.push(isRolled ? (rolled === fields && i === 0 ? "Grand total" : "Total") : row[i]);
        }
        for (let m = 0; m < measures; m++) {
            const value = row[fields + m];
            out.push(value);
            if (ADDITIVE.has(values[m]?.agg ?? "count") && grand) {
                const total = Number(grand[fields + m]);
                const share = Number(value);
                // Two decimals, not one: at one, a subtotal of 99.97% printed as 100 beside the
                // grand total's 100, and every share under 0.05% printed as a flat 0.
                out.push(total && Number.isFinite(share) ? Math.round((share / total) * 10000) / 100 : null);
            }
        }
        return out;
    });

    return { columns, rows };
}
