import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import { DataTable, type Column } from "./DataTable";
import { formatCell, isNumericType } from "./cell";

// Sorgu sonucunu gösteren genel bileşen. Yalnızca tablo önizlemesi için değil:
// ileride serbest sorgu, WHERE doğrulama ve üretim raporları da bunu kullanacak,
// bu yüzden tablo/şema kavramlarını hiç bilmiyor — yalnızca kolonlar, satırlar,
// süre ve mesajlar.

export interface ResultColumn {
    name: string;
    typeName: string;
    truncated: boolean;
    // Başlığın üzerine gelince açılacak ek bilgi; çağıran doldurur.
    details?: ReactNode;
}

// Seçim SSMS'teki gibi: satır numarasına tıklamak satırı, başlığa tıklamak
// kolonu, sol üst köşeye tıklamak tümünü seçer. Ctrl/Cmd ile eklenir.
interface Selection {
    rows: Set<number>;
    cols: Set<string>;
    all: boolean;
}

const EMPTY: Selection = { rows: new Set(), cols: new Set(), all: false };

export interface ResultGridProps {
    columns: ResultColumn[];
    rows: (string | number | boolean | null)[][];
    elapsedMs: number;
    messages: string[];
    // Satır sayısı sınırlıysa gösterilecek üst sınır (ör. TOP 20).
    limitNote?: string;
}

interface GridRow {
    index: number;
    values: (string | number | boolean | null)[];
}

export function ResultGrid({ columns, rows, elapsedMs, messages, limitNote }: ResultGridProps) {
    const [tab, setTab] = useState<"results" | "messages">("results");
    const [selection, setSelection] = useState<Selection>(EMPTY);

    // Yeni bir sonuç geldiğinde eski seçim anlamını yitirir.
    useEffect(() => setSelection(EMPTY), [rows, columns]);

    const gridRows: GridRow[] = useMemo(
        () => rows.map((values, index) => ({ index, values })),
        [rows],
    );

    const columnKeys = useMemo(() => columns.map((c, i) => `${i}-${c.name}`), [columns]);

    const selectRow = useCallback((row: GridRow, additive: boolean) => {
        setSelection((current) => {
            const next = additive && !current.all ? new Set(current.rows) : new Set<number>();
            if (next.has(row.index)) {
                next.delete(row.index);
            } else {
                next.add(row.index);
            }
            return { rows: next, cols: new Set(), all: false };
        });
    }, []);

    const selectColumn = useCallback((key: string, additive: boolean) => {
        setSelection((current) => {
            const next = additive && !current.all ? new Set(current.cols) : new Set<string>();
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return { rows: new Set(), cols: next, all: false };
        });
    }, []);

    const selectAll = useCallback(() => {
        setSelection((current) => (current.all ? EMPTY : { rows: new Set(), cols: new Set(), all: true }));
    }, []);

    // Seçim ancak kopyalanabiliyorsa işe yarar: TSV olarak panoya yazılır,
    // yani doğrudan bir tabloya yapıştırılabilir.
    useEffect(() => {
        function onCopy(event: ClipboardEvent) {
            const hasSelection = selection.all || selection.rows.size > 0 || selection.cols.size > 0;
            if (!hasSelection || window.getSelection()?.toString()) {
                return;
            }

            const cols = columns
                .map((c, i) => ({ c, i }))
                .filter(({ i }) => selection.all || selection.cols.size === 0 || selection.cols.has(columnKeys[i]));
            const picked = gridRows.filter(
                (r) => selection.all || selection.rows.size === 0 || selection.rows.has(r.index),
            );

            const text = [
                cols.map(({ c }) => c.name).join("\t"),
                ...picked.map((r) => cols.map(({ i }) => r.values[i] ?? "NULL").join("\t")),
            ].join("\n");

            event.clipboardData?.setData("text/plain", text);
            event.preventDefault();
        }

        document.addEventListener("copy", onCopy);
        return () => document.removeEventListener("copy", onCopy);
    }, [selection, columns, columnKeys, gridRows]);

    // Sol kenarda satır numarası; başlığındaki köşe hücresi tümünü seçer.
    const numberColumn: Column<GridRow> = {
        key: "__rownum",
        // Düğme hücrenin tamamını kaplar: küçük bir simgeyi tutturmak gerekmesin.
        header: (
            <>
                <button type="button" className="corner" onClick={selectAll} aria-label="Select all">
                    ◧
                </button>
                <span className="colinfo">
                    <span className="card">
                        <b>Select all</b>
                        <span className="muted">
                            Selects every row and column. Ctrl/Cmd+C copies the selection as
                            tab-separated text.
                        </span>
                    </span>
                </span>
            </>
        ),
        render: (row) => row.index + 1,
        className: "rownum",
        plain: true,
    };

    const dataColumns: Column<GridRow>[] = columns.map((column, i) => ({
        key: columnKeys[i],
        numeric: isNumericType(column.typeName),
        header: column.name,
        info: (
            <span className="card">
                <b className="mono">{column.name}</b>
                <span className="mono muted">{column.typeName}</span>
                {column.details}
                {column.truncated && (
                    <span className="warn-line">
                        Truncated to 256 characters for this preview. Large text and binary values are
                        not transferred in full.
                    </span>
                )}
            </span>
        ),
        sortValue: (row) => row.values[i],
        render: (row) => formatCell(row.values[i], column.typeName),
        className: isNumericType(column.typeName) ? undefined : "mono",
        // NULL hücresinin zemini boyanır; "değer yok" ile "değer boş" karışmasın.
        cellClassName: (row) => (row.values[i] === null ? "isnull" : undefined),
    }));

    return (
        <div className="result">
            <div className="result-tabs">
                <button className="tab" aria-selected={tab === "results"} onClick={() => setTab("results")}>
                    Results
                </button>
                <button className="tab" aria-selected={tab === "messages"} onClick={() => setTab("messages")}>
                    Messages{messages.length > 0 && <span className="count">{messages.length}</span>}
                </button>
            </div>

            {tab === "results" ? (
                // Satır gelmese bile başlıklar gösterilir: hangi kolonların
                // sorgulandığı sonucun boş olmasından bağımsız bir bilgi.
                <DataTable
                    columns={[numberColumn, ...dataColumns]}
                    rows={gridRows}
                    rowKey={(row) => String(row.index)}
                    dense
                    resizable
                    selection={{
                        isRowSelected: (row) => selection.all || selection.rows.has(row.index),
                        isColumnSelected: (key) => selection.all || selection.cols.has(key),
                        onRow: selectRow,
                        onColumn: selectColumn,
                    }}
                />
            ) : (
                messages.length === 0 ? (
                    <div className="empty-note">The server returned no messages.</div>
                ) : (
                    <div className="messages">
                        {messages.map((message, i) => (
                            <div key={i}>{message}</div>
                        ))}
                    </div>
                )
            )}

            <div className="status">
                <span>
                    {rows.length} {rows.length === 1 ? "row" : "rows"}
                    {limitNote && <span className="muted"> · {limitNote}</span>}
                </span>
                <span>
                    {columns.length} {columns.length === 1 ? "column" : "columns"}
                </span>
                <span className="grow" />
                <span title="Time from sending the command to reading the last row">{elapsedMs} ms</span>
            </div>
        </div>
    );
}
