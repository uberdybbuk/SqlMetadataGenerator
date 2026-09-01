import { type ReactNode, useMemo, useState } from "react";

export type SortValue = string | number | boolean | null;

export interface Column<T> {
    key: string;
    header: ReactNode;
    // Sayısal kolonlar sağa yaslanır ve ilk tıklamada büyükten küçüğe sıralanır.
    numeric?: boolean;
    // Sıralamada kullanılacak ham değer. Verilmezse kolon sıralanamaz.
    sortValue?: (row: T) => SortValue;
    render: (row: T) => ReactNode;
    className?: string;
}

interface DataTableProps<T> {
    columns: Column<T>[];
    rows: T[];
    rowKey: (row: T) => string;
    initialSort?: { key: string; desc?: boolean };
    // Sıralamadan SONRA uygulanır: "şuna göre ilk N" anlamı korunur.
    limit?: number;
}

// Tüm listelerde ortak sıralama davranışı. Her kolon sıralanabilir (sortValue
// verildiği sürece); metinler Türkçe sıralama kurallarıyla, null'lar her zaman sona.
export function DataTable<T>({ columns, rows, rowKey, initialSort, limit }: DataTableProps<T>) {
    const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(
        initialSort ? { key: initialSort.key, desc: initialSort.desc ?? false } : null,
    );

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

    return (
        <div className="table-wrap">
            <table>
                <thead>
                    <tr>
                        {columns.map((column) => {
                            const active = sort?.key === column.key;
                            return (
                                <th
                                    key={column.key}
                                    className={column.numeric ? "num" : undefined}
                                    aria-sort={active ? (sort!.desc ? "descending" : "ascending") : undefined}
                                >
                                    {column.sortValue ? (
                                        <button
                                            type="button"
                                            className={active ? "sort active" : "sort"}
                                            onClick={() => toggle(column)}
                                        >
                                            {column.header}
                                            <span className="arrow">{active ? (sort!.desc ? "↓" : "↑") : ""}</span>
                                        </button>
                                    ) : (
                                        column.header
                                    )}
                                </th>
                            );
                        })}
                    </tr>
                </thead>
                <tbody>
                    {sorted.map((row) => (
                        <tr key={rowKey(row)}>
                            {columns.map((column) => (
                                <td
                                    key={column.key}
                                    className={[column.numeric ? "num" : "", column.className ?? ""]
                                        .filter(Boolean)
                                        .join(" ")}
                                >
                                    {column.render(row)}
                                </td>
                            ))}
                        </tr>
                    ))}
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
    return String(a).localeCompare(String(b), "tr", { numeric: true, sensitivity: "base" });
}
