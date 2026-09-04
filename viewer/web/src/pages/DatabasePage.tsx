import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Chart } from "../echarts";

import { api, type TableStats } from "../api";
import { useApi } from "../useApi";
import { formatKb, formatRows, plural } from "../format";
import { labelColorFor, rampFor, sampleRamp, useDarkMode } from "../theme";
import { DataTable, type Column } from "../DataTable";
import { Icon, type IconName } from "../Icon";

// Object type counters: display order, singular label and icon.
// The plural form is derived from the number — so nothing reads "1 procedures".
const KINDS: [key: string, singular: string, icon: IconName][] = [
    ["tables", "table", "table"],
    ["views", "view", "view"],
    ["procedures", "procedure", "procedure"],
    ["functions", "function", "function"],
    ["triggers", "trigger", "trigger"],
    ["synonyms", "synonym", "synonym"],
    ["sequences", "sequence", "sequence"],
    ["types", "type", "type"],
    ["schemas", "schema", "schema"],
];

export function DatabasePage() {
    const { alias = "", db = "" } = useParams();
    const navigate = useNavigate();
    const dark = useDarkMode();

    // A single table can take up 90% of a database; the top-level map then tells the truth but
    // makes the tail unreadable. Drilling into a schema makes the scale meaningful again —
    // without distorting area (the area = magnitude contract holds).
    const [drill, setDrill] = useState<string | null>(null);

    const overview = useApi(() => api.database(alias, db), [alias, db]);
    const tables = useApi(() => api.tables(alias, db), [alias, db]);

    const base = `/app/${encodeURIComponent(alias)}/${encodeURIComponent(db)}`;
    const rows = tables.data ?? [];
    const sized = useMemo(() => rows.filter((t) => t.reservedKb > 0), [rows]);
    const inScope = useMemo(
        () => (drill ? sized.filter((t) => t.schema === drill) : sized),
        [sized, drill],
    );
    const option = useMemo(() => buildTreemap(inScope, dark, drill !== null), [inScope, dark, drill]);

    const totalKb = rows.reduce((sum, t) => sum + t.reservedKb, 0);
    const totalRows = rows.reduce((sum, t) => sum + t.rowCount, 0);
    const ranked = [...rows].sort((a, b) => b.reservedKb - a.reservedKb);

    // When one table covers more than half the area, that is the real finding, and a sentence
    // conveys it faster than a chart. In that situation the treemap says "one thing covers
    // everything" but can say nothing at all about the tail.
    const top = ranked[0];
    const dominance = top && totalKb > 0 ? (top.reservedKb / totalKb) * 100 : 0;

    const columns: Column<TableStats>[] = [
        {
            key: "schema",
            header: "Schema",
            sortValue: (t) => t.schema,
            render: (t) => (
                <Link className="mono muted with-icon" to={`${base}/tables/${encodeURIComponent(t.schema)}`}>
                    <Icon name="schema" />
                    {t.schema}
                </Link>
            ),
        },
        {
            key: "name",
            header: "Table",
            sortValue: (t) => t.name,
            render: (t) => (
                <Link
                    className="mono with-icon"
                    to={`${base}/tables/${encodeURIComponent(t.schema)}/${encodeURIComponent(t.name)}`}
                >
                    <Icon name="table" />
                    {t.name}
                </Link>
            ),
        },
        { key: "rows", header: "Rows", numeric: true, sortValue: (t) => t.rowCount, render: (t) => formatRows(t.rowCount) },
        { key: "reserved", header: "Allocated", numeric: true, sortValue: (t) => t.reservedKb, render: (t) => formatKb(t.reservedKb) },
        {
            key: "used",
            header: "Used",
            numeric: true,
            sortValue: (t) => t.usedKb,
            render: (t) => <span className="muted">{formatKb(t.usedKb)}</span>,
        },
    ];

    return (
        <>
            <h1>{db}</h1>
            <p className="subtitle">
                Database on <span className="mono">{alias}</span>
            </p>

            {overview.error && <div className="error">{overview.error}</div>}
            {overview.data && (
                <div className="badges">
                    {KINDS.filter(([key]) => overview.data!.counts[key]).map(([key, singular, icon]) => (
                        <span key={key} className="badge">
                            <Icon name={icon} size={14} />
                            <b>{overview.data!.counts[key]}</b>{" "}
                            {plural(overview.data!.counts[key], singular)}
                        </span>
                    ))}
                </div>
            )}

            {tables.error && <div className="error">{tables.error}</div>}
            {tables.loading && <div className="state">Reading table statistics…</div>}

            {!tables.loading && rows.length > 0 && (
                <>
                    {dominance >= 50 && (
                        <p
                            style={{
                                background: "var(--accent-soft)",
                                border: "1px solid var(--border)",
                                borderRadius: 8,
                                padding: "12px 16px",
                                margin: "8px 0 0",
                            }}
                        >
                            <b>{dominance.toLocaleString("en-US", { maximumFractionDigits: 1 })}%</b>{" "}
                            of allocated space sits in a single table:{" "}
                            <Link
                                className="mono"
                                to={`${base}/tables/${encodeURIComponent(top.schema)}/${encodeURIComponent(top.name)}`}
                            >
                                {top.schema}.{top.name}
                            </Link>{" "}
                            ({formatKb(top.reservedKb)} / {formatKb(totalKb)}).
                        </p>
                    )}

                    <h2>
                        Disk footprint{" "}
                        <span className="muted" style={{ fontWeight: 400 }}>
                            — box size is allocated space, color is row count
                        </span>
                    </h2>
                    <div className="toolbar">
                        <button className="chip" aria-pressed={drill === null} onClick={() => setDrill(null)}>
                            all schemas
                        </button>
                        {drill && (
                            <span className="muted">
                                {inScope.length} {plural(inScope.length, "table")} in{" "}
                                <span className="mono">{drill}</span>
                            </span>
                        )}
                        {!drill && <span className="muted">click a schema to drill in</span>}
                    </div>

                    <div style={{ border: "1px solid var(--border)", borderRadius: 8, background: "var(--panel)" }}>
                        <Chart
                            option={option}
                            style={{ height: 460 }}
                            opts={{ renderer: "canvas" }}
                            onEvents={{
                                click: ((params: { name?: string; data?: { schema?: string; table?: string } }) => {
                                    const { schema, table } = params.data ?? {};
                                    if (schema && table) {
                                        navigate(`${base}/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}`);
                                    } else if (params.name) {
                                        setDrill(params.name);
                                    }
                                }) as never,
                            }}
                        />
                        <ColorScale dark={dark} />
                    </div>

                    <p className="subtitle" style={{ marginTop: 12 }}>
                        ~{formatRows(totalRows)} rows, {formatKb(totalKb)} allocated in total.
                        {rows.length - sized.length > 0 && (
                            <>
                                {" "}
                                {rows.length - sized.length}{" "}
                                {plural(rows.length - sized.length, "empty table", "empty tables")} not on the
                                map.
                            </>
                        )}{" "}
                        Counts come from catalog views without scanning — they are approximate.
                    </p>

                    <h2>Largest tables</h2>
                    <DataTable
                        columns={columns}
                        rows={rows}
                        rowKey={(t) => `${t.schema}.${t.name}`}
                        initialSort={{ key: "reserved", desc: true }}
                        dense
                        limit={15}
                    />
                    <p style={{ marginTop: 12 }}>
                        <Link to={`${base}/tables`}>List all {rows.length} tables →</Link>
                    </p>
                </>
            )}
        </>
    );
}

// A small scale showing what the ramp means. A categorical legend does not fit, because the
// colour encodes a continuous magnitude.
function ColorScale({ dark }: { dark: boolean }) {
    const ramp = rampFor(dark);
    return (
        <div
            style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 16px 14px",
                fontSize: 12,
                color: "var(--muted)",
            }}
        >
            <span>fewer rows</span>
            <span
                style={{
                    display: "inline-block",
                    width: 160,
                    height: 8,
                    borderRadius: 4,
                    background: `linear-gradient(to right, ${ramp.join(", ")})`,
                }}
            />
            <span>more rows</span>
        </div>
    );
}

function buildTreemap(rows: TableStats[], dark: boolean, flat: boolean) {
    const ramp = rampFor(dark);
    const labelColor = labelColorFor(dark);
    const surface = dark ? "#1d1f23" : "#ffffff";

    // Row counts are spread across orders of magnitude, so the normalisation is logarithmic:
    // otherwise one huge table crushes everything else into the same colour.
    const logs = rows.map((t) => Math.log10(t.rowCount + 1));
    const maxLog = Math.max(...logs, 1);

    const bySchema = new Map<string, TableStats[]>();
    for (const row of rows) {
        const list = bySchema.get(row.schema);
        if (list) {
            list.push(row);
        } else {
            bySchema.set(row.schema, [row]);
        }
    }

    const leaf = (t: TableStats) => ({
        name: t.name,
        value: t.reservedKb,
        schema: t.schema,
        table: t.name,
        rowCount: t.rowCount,
        itemStyle: { color: sampleRamp(ramp, Math.log10(t.rowCount + 1) / maxLog) },
    });

    // Inside a schema there is a single level: the grouping layer no longer carries information,
    // it only takes up room.
    const data = flat
        ? rows.map(leaf).sort((a, b) => b.value - a.value)
        : [...bySchema.entries()]
              .map(([schema, tablesInSchema]) => ({
                  name: schema,
                  value: tablesInSchema.reduce((sum, t) => sum + t.reservedKb, 0),
                  children: tablesInSchema.map(leaf),
              }))
              .sort((a, b) => b.value - a.value);

    return {
        tooltip: {
            formatter: (info: { name: string; value: number; data: { schema?: string; rowCount?: number } }) => {
                const { schema, rowCount } = info.data ?? {};
                const title = schema ? `${schema}.${info.name}` : info.name;
                const rowsLine = rowCount === undefined ? "" : `<br/>~${formatRows(rowCount)} rows`;
                return `<b>${title}</b><br/>${formatKb(info.value)} allocated${rowsLine}`;
            },
        },
        series: [
            {
                type: "treemap",
                roam: false,
                nodeClick: false,
                breadcrumb: { show: false },
                width: "100%",
                height: "100%",
                top: 8,
                left: 8,
                right: 8,
                bottom: 8,
                // The schema block's header: identity is carried by the grouping and the label, not the colour.
                upperLabel: {
                    show: !flat,
                    height: 20,
                    color: labelColor,
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 11,
                },
                itemStyle: { borderColor: surface, borderWidth: 2, gapWidth: 2 },
                levels: [
                    {
                        itemStyle: { borderColor: surface, borderWidth: 3, gapWidth: 3 },
                        upperLabel: { show: true },
                    },
                    {
                        itemStyle: { borderColor: surface, borderWidth: 1, gapWidth: 1 },
                    },
                ],
                label: {
                    show: true,
                    color: labelColor,
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 11,
                    overflow: "truncate",
                },
                data,
            },
        ],
    };
}
