import { type ReactNode, useState } from "react";

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

    const gridRows: GridRow[] = rows.map((values, index) => ({ index, values }));

    // Sol kenarda satır numarası: SSMS'teki gibi, kaydırırken sabit kalır.
    const numberColumn: Column<GridRow> = {
        key: "__rownum",
        header: "",
        render: (row) => row.index + 1,
        className: "rownum",
    };

    const dataColumns: Column<GridRow>[] = columns.map((column, i) => ({
        key: `${i}-${column.name}`,
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
                rows.length === 0 ? (
                    <div className="state">No rows.</div>
                ) : (
                    <DataTable
                        columns={[numberColumn, ...dataColumns]}
                        rows={gridRows}
                        rowKey={(row) => String(row.index)}
                        dense
                        resizable
                    />
                )
            ) : (
                <div className="messages">
                    {messages.length === 0 ? (
                        <span className="muted">The server returned no messages.</span>
                    ) : (
                        messages.map((message, i) => <div key={i}>{message}</div>)
                    )}
                </div>
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
