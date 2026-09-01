import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Chart } from "../echarts";

import { api, type TableStats } from "../api";
import { useApi } from "../useApi";
import { formatKb, formatRows } from "../format";
import { labelColorFor, rampFor, sampleRamp, useDarkMode } from "../theme";
import { DataTable, type Column } from "../DataTable";

// Nesne tipi sayaçları için gösterim sırası ve etiketleri.
const KIND_LABELS: [string, string][] = [
    ["tables", "tablo"],
    ["views", "view"],
    ["procedures", "procedure"],
    ["functions", "function"],
    ["triggers", "trigger"],
    ["synonyms", "synonym"],
    ["sequences", "sequence"],
    ["types", "type"],
    ["schemas", "şema"],
];

export function DatabasePage() {
    const { alias = "", db = "" } = useParams();
    const navigate = useNavigate();
    const dark = useDarkMode();

    // Tek tablo veritabanının %90'ını kaplayabiliyor; o durumda üst seviye harita
    // gerçeği doğru söyler ama kuyruğu okunmaz kılar. Şemaya inince ölçek yeniden
    // anlamlı hale gelir — alanı çarpıtmadan (alan = büyüklük sözleşmesi korunur).
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

    // Tek tablo alanın yarısından fazlasını kaplıyorsa asıl bilgi budur ve bir
    // grafikten değil bir cümleden daha hızlı okunur. Treemap bu durumda "bir şey
    // her şeyi kaplıyor" der ama kuyruk hakkında hiçbir şey söyleyemez.
    const top = ranked[0];
    const dominance = top && totalKb > 0 ? (top.reservedKb / totalKb) * 100 : 0;

    const columns: Column<TableStats>[] = [
        {
            key: "schema",
            header: "Şema",
            sortValue: (t) => t.schema,
            render: (t) => (
                <Link className="mono muted" to={`${base}/tables/${encodeURIComponent(t.schema)}`}>
                    {t.schema}
                </Link>
            ),
        },
        {
            key: "name",
            header: "Tablo",
            sortValue: (t) => t.name,
            render: (t) => (
                <Link
                    className="mono"
                    to={`${base}/tables/${encodeURIComponent(t.schema)}/${encodeURIComponent(t.name)}`}
                >
                    {t.name}
                </Link>
            ),
        },
        { key: "rows", header: "Satır", numeric: true, sortValue: (t) => t.rowCount, render: (t) => formatRows(t.rowCount) },
        { key: "reserved", header: "Ayrılmış", numeric: true, sortValue: (t) => t.reservedKb, render: (t) => formatKb(t.reservedKb) },
        {
            key: "used",
            header: "Kullanılan",
            numeric: true,
            sortValue: (t) => t.usedKb,
            render: (t) => <span className="muted">{formatKb(t.usedKb)}</span>,
        },
    ];

    return (
        <>
            <h1>{db}</h1>
            <p className="subtitle">
                <span className="mono">{alias}</span> sunucusundaki veritabanı
            </p>

            {overview.error && <div className="error">{overview.error}</div>}
            {overview.data && (
                <div className="badges">
                    {KIND_LABELS.filter(([key]) => overview.data!.counts[key]).map(([key, label]) => (
                        <span key={key} className="badge">
                            <b>{overview.data!.counts[key]}</b> {label}
                        </span>
                    ))}
                </div>
            )}

            {tables.error && <div className="error">{tables.error}</div>}
            {tables.loading && <div className="state">Tablo istatistikleri okunuyor…</div>}

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
                            Ayrılmış alanın{" "}
                            <b>%{dominance.toLocaleString("tr-TR", { maximumFractionDigits: 1 })}</b>{" "}
                            tek bir tabloda:{" "}
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
                        Disk dağılımı{" "}
                        <span className="muted" style={{ fontWeight: 400 }}>
                            — kutu boyutu ayrılmış alan, renk satır sayısı
                        </span>
                    </h2>
                    <div className="toolbar">
                        <button className="chip" aria-pressed={drill === null} onClick={() => setDrill(null)}>
                            tüm şemalar
                        </button>
                        {drill && (
                            <span className="muted">
                                <span className="mono">{drill}</span> şemasındaki {inScope.length} tablo
                            </span>
                        )}
                        {!drill && <span className="muted">bir şemaya tıklayarak içine inebilirsin</span>}
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
                        Toplam ~{formatRows(totalRows)} satır, {formatKb(totalKb)} ayrılmış alan.
                        {rows.length - sized.length > 0 && (
                            <> {rows.length - sized.length} tablo boş olduğu için haritada yer almıyor.</>
                        )}{" "}
                        Sayılar katalog view'larından okunur, tarama yapılmaz — yaklaşıktır.
                    </p>

                    <h2>En büyük tablolar</h2>
                    <DataTable
                        columns={columns}
                        rows={rows}
                        rowKey={(t) => `${t.schema}.${t.name}`}
                        initialSort={{ key: "reserved", desc: true }}
                        limit={15}
                    />
                    <p style={{ marginTop: 12 }}>
                        <Link to={`${base}/tables`}>Tüm {rows.length} tabloyu listele →</Link>
                    </p>
                </>
            )}
        </>
    );
}

// Rampanın ne anlama geldiğini gösteren küçük ölçek. Renk sürekli bir büyüklüğü
// kodladığı için kategorik bir legend uygun değil.
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
            <span>az satır</span>
            <span
                style={{
                    display: "inline-block",
                    width: 160,
                    height: 8,
                    borderRadius: 4,
                    background: `linear-gradient(to right, ${ramp.join(", ")})`,
                }}
            />
            <span>çok satır</span>
        </div>
    );
}

function buildTreemap(rows: TableStats[], dark: boolean, flat: boolean) {
    const ramp = rampFor(dark);
    const labelColor = labelColorFor(dark);
    const surface = dark ? "#1d1f23" : "#ffffff";

    // Satır sayıları büyüklük mertebeleri arasında dağıldığı için logaritmik
    // normalizasyon: aksi hâlde tek dev tablo diğer her şeyi aynı renge ezer.
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

    // Şemaya inildiğinde tek seviye: gruplama katmanı artık bilgi taşımıyor,
    // yalnızca yer kaplıyor.
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
                const rowsLine = rowCount === undefined ? "" : `<br/>~${formatRows(rowCount)} satır`;
                return `<b>${title}</b><br/>${formatKb(info.value)} ayrılmış${rowsLine}`;
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
                // Şema bloğunun başlığı: kimliği renk değil, gruplama ve etiket taşır.
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
