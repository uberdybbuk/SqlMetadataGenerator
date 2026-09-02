import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

export type SortValue = string | number | boolean | null;

export interface Column<T> {
    key: string;
    header: ReactNode;
    // Başlığın üzerine gelince açılan kart. Tip gibi ikincil bilgiler burada
    // durur: başlık satırına yazıldıklarında kolonu gereksiz yere genişletiyorlardı.
    info?: ReactNode;
    // Sayısal kolonlar sağa yaslanır ve ilk tıklamada büyükten küçüğe sıralanır.
    numeric?: boolean;
    // Sıralamada kullanılacak ham değer. Verilmezse kolon sıralanamaz.
    sortValue?: (row: T) => SortValue;
    render: (row: T) => ReactNode;
    className?: string;
    // Satıra göre değişen hücre sınıfı (ör. NULL hücresini boyamak için).
    cellClassName?: (row: T) => string | undefined;
    // Başlık olduğu gibi çizilir: sıralama/seçim düğmesi sarmalanmaz ve
    // genişliği ölçülmez. Satır numarası oluğu gibi kendi kontrolünü taşıyan
    // kolonlar için — aksi hâlde düğme içine düğme yerleşiyor.
    plain?: boolean;
}

interface DataTableProps<T> {
    columns: Column<T>[];
    rows: T[];
    rowKey: (row: T) => string;
    initialSort?: { key: string; desc?: boolean };
    // Sıralamadan SONRA uygulanır: "şuna göre ilk N" anlamı korunur.
    limit?: number;
    // Veri ızgarası için daha sıkı satır yüksekliği ve küçük yazı.
    dense?: boolean;
    // Kolon kenarlarından sürükleyerek genişlik ayarlama.
    resizable?: boolean;
    // Ölçülen genişliğin üst sınırı; tek bir uzun değer kolonu ekranı yutmasın.
    maxWidth?: number;
    // Seçim: başlığa tıklamak kolonu seçer, sıralama ayrı bir düğmeye taşınır.
    // Verilmezse başlığın tamamı sıralama düğmesidir (liste sayfalarındaki davranış).
    selection?: {
        isRowSelected: (row: T) => boolean;
        isColumnSelected: (key: string) => boolean;
        isCellSelected: (row: T, key: string) => boolean;
        onRow: (row: T, additive: boolean) => void;
        onColumn: (key: string, additive: boolean) => void;
        onCell: (row: T, key: string, additive: boolean) => void;
    };
}

const MIN_WIDTH = 56;

export function DataTable<T>({
    columns,
    rows,
    rowKey,
    initialSort,
    limit,
    dense,
    resizable,
    maxWidth = 320,
    selection,
}: DataTableProps<T>) {
    const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(
        initialSort ? { key: initialSort.key, desc: initialSort.desc ?? false } : null,
    );
    const [widths, setWidths] = useState<Record<string, number> | null>(null);
    const tableRef = useRef<HTMLTableElement>(null);

    // Genişlikleri tarayıcının otomatik yerleşiminden ölçüp sabitleriz. Aksi hâlde
    // table-layout:fixed baştan devreye girip her kolona eşit genişlik verirdi.
    useLayoutEffect(() => {
        if (!resizable || widths || !tableRef.current) {
            return;
        }
        const cells = tableRef.current.querySelectorAll("thead th");
        const measured: Record<string, number> = {};
        cells.forEach((cell, i) => {
            const column = columns[i];
            if (column) {
                // plain kolonlar da ölçülür: genişlikleri CSS'ten gelse bile
                // tablonun toplam genişliğine katkıları sayılmalı.
                measured[column.key] = Math.min(
                    maxWidth,
                    Math.max(MIN_WIDTH, Math.round(cell.getBoundingClientRect().width)),
                );
            }
        });
        if (Object.keys(measured).length > 0) {
            setWidths(measured);
        }
    }, [resizable, widths, columns, maxWidth]);

    // Kolon değişince (başka tabloya geçince) ölçüm sıfırlanmalı.
    const columnKeys = columns.map((c) => c.key).join("|");
    const previousKeys = useRef(columnKeys);
    if (previousKeys.current !== columnKeys) {
        previousKeys.current = columnKeys;
        if (widths) {
            setWidths(null);
        }
    }

    const startResize = useCallback((key: string, event: React.MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        const startX = event.clientX;
        const th = (event.currentTarget as HTMLElement).closest("th");
        const startWidth = th?.getBoundingClientRect().width ?? MIN_WIDTH;

        const onMove = (e: MouseEvent) => {
            const next = Math.max(MIN_WIDTH, Math.round(startWidth + e.clientX - startX));
            setWidths((current) => ({ ...(current ?? {}), [key]: next }));
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            document.body.classList.remove("resizing");
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        document.body.classList.add("resizing");
    }, []);

    const sorted = useMemo(() => {
        const column = sort && columns.find((c) => c.key === sort.key);
        if (!column?.sortValue) {
            return limit ? rows.slice(0, limit) : rows;
        }
        const direction = sort!.desc ? -1 : 1;
        const copy = [...rows].sort((a, b) => compare(column.sortValue!(a), column.sortValue!(b)) * direction);
        return limit ? copy.slice(0, limit) : copy;
    }, [rows, columns, sort, limit]);

    function toggle(column: Column<T>) {
        if (!column.sortValue) {
            return;
        }
        setSort((current) =>
            current?.key === column.key
                ? { key: column.key, desc: !current.desc }
                : // Sayısalda ilk tıklama büyükten küçüğe: aranan genelde en büyüktür.
                  { key: column.key, desc: column.numeric === true },
        );
    }

    const fixed = resizable && widths !== null;
    // Sabit yerleşimde tablo genişliği AÇIKÇA verilir. "max-content" bırakılırsa
    // tarayıcı hücre içeriğine göre büyüyüp colgroup'taki genişlikleri eziyor;
    // "auto" bırakılırsa kapsayıcıya yayılıyor. İkisi de kolonları şişiriyordu.
    const totalWidth = fixed ? Object.values(widths!).reduce((sum, w) => sum + w, 0) : undefined;

    return (
        <div className={dense ? "table-wrap dense" : "table-wrap"}>
            <table
                ref={tableRef}
                style={fixed ? { tableLayout: "fixed", width: totalWidth } : undefined}
            >
                {fixed && (
                    <colgroup>
                        {columns.map((c) => (
                            <col key={c.key} style={c.plain ? undefined : { width: widths![c.key] }} />
                        ))}
                    </colgroup>
                )}
                <thead>
                    <tr>
                        {columns.map((column) => {
                            const active = sort?.key === column.key;
                            const arrow = active ? (sort!.desc ? "↓" : "↑") : "⇅";
                            const selected = selection?.isColumnSelected(column.key) ?? false;
                            return (
                                <th
                                    key={column.key}
                                    className={[column.numeric ? "num" : "", selected ? "selected" : ""]
                                        .filter(Boolean)
                                        .join(" ")}
                                    aria-sort={active ? (sort!.desc ? "descending" : "ascending") : undefined}
                                >
                                    {column.plain ? (
                                        column.header
                                    ) : selection ? (
                                        // Ad kolonu seçer, ok sıralar: ikisi ayrı düğme.
                                        <span className="sort">
                                            <button
                                                type="button"
                                                className="hname pick"
                                                onClick={(e) => selection.onColumn(column.key, e.metaKey || e.ctrlKey)}
                                            >
                                                {column.header}
                                            </button>
                                            {column.sortValue && (
                                                <button
                                                    type="button"
                                                    className={active ? "arrow sortbtn active" : "arrow sortbtn"}
                                                    onClick={() => toggle(column)}
                                                    aria-label="Sort"
                                                >
                                                    {arrow}
                                                </button>
                                            )}
                                        </span>
                                    ) : column.sortValue ? (
                                        <button
                                            type="button"
                                            className={active ? "sort active" : "sort"}
                                            onClick={() => toggle(column)}
                                        >
                                            <span className="hname">{column.header}</span>
                                            <span className="arrow">{active ? (sort!.desc ? "↓" : "↑") : ""}</span>
                                        </button>
                                    ) : (
                                        <span className="sort">
                                            <span className="hname">{column.header}</span>
                                        </span>
                                    )}
                                    {column.info && <span className="colinfo">{column.info}</span>}
                                    {resizable && !column.plain && (
                                        <span
                                            className="resizer"
                                            onMouseDown={(e) => startResize(column.key, e)}
                                            role="separator"
                                            aria-orientation="vertical"
                                            aria-label={`Resize column`}
                                        />
                                    )}
                                </th>
                            );
                        })}
                    </tr>
                </thead>
                <tbody>
                    {sorted.map((row) => {
                        const rowSelected = selection?.isRowSelected(row) ?? false;
                        return (
                            <tr key={rowKey(row)} className={rowSelected ? "selected" : undefined}>
                                {columns.map((column) => {
                                    const isRowNumber = column.className === "rownum";
                                    return (
                                        <td
                                            key={column.key}
                                            onClick={
                                                !selection
                                                    ? undefined
                                                    : isRowNumber
                                                      ? (e) => selection.onRow(row, e.metaKey || e.ctrlKey)
                                                      : (e) => selection.onCell(row, column.key, e.metaKey || e.ctrlKey)
                                            }
                                            className={[
                                                column.numeric ? "num" : "",
                                                column.className ?? "",
                                                column.cellClassName?.(row) ?? "",
                                                isRowNumber
                                                    ? rowSelected
                                                        ? "selected"
                                                        : ""
                                                    : selection?.isCellSelected(row, column.key)
                                                      ? "selected"
                                                      : "",
                                            ]
                                                .filter(Boolean)
                                                .join(" ")}
                                        >
                                            {column.render(row)}
                                        </td>
                                    );
                                })}
                            </tr>
                        );
                    })}
                    {sorted.length === 0 && (
                        <tr className="norows">
                            <td colSpan={columns.length} className="empty-note">
                                The query returned no rows.
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
}

// null/undefined her zaman sona gider; yön değişse bile boş değerler öne çıkmaz.
function compare(a: SortValue, b: SortValue): number {
    const aEmpty = a === null || a === undefined || a === "";
    const bEmpty = b === null || b === undefined || b === "";
    if (aEmpty || bEmpty) {
        return aEmpty && bEmpty ? 0 : aEmpty ? 1 : -1;
    }
    if (typeof a === "number" && typeof b === "number") {
        return a - b;
    }
    if (typeof a === "boolean" && typeof b === "boolean") {
        return Number(a) - Number(b);
    }
    return String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });
}
