import type { ReactNode } from "react";

// Değerleri SQL tipine göre biçimlendirir.
//
// Backend tarih/saat değerlerini ISO 8601 ("o") olarak gönderir; bu makine için
// doğru ama ekranda okumak için kötü: bir `date` kolonunda "2026-07-22T00:00:00.0000000"
// yazmanın anlamı yok, saat kısmı tanım gereği sıfır. Aradaki 'T' de ISO'nun
// ayracı, insana bir şey söylemiyor.
//
// Saniye altı kısım ayrı bir <span> olarak döner: değer tam gösterilir ama
// göz önce anlamlı kısmı yakalar.

const DATE_ONLY = new Set(["date"]);
const DATE_TIME = new Set(["datetime", "datetime2", "smalldatetime", "datetimeoffset"]);
const TIME_ONLY = new Set(["time"]);

export function formatCell(value: unknown, typeName: string): ReactNode {
    if (value === null || value === undefined) {
        return <span className="null">NULL</span>;
    }

    const t = typeName.toLowerCase();
    const text = String(value);

    if (DATE_ONLY.has(t)) {
        // "2026-07-22T00:00:00.0000000" -> "2026-07-22"
        return text.slice(0, 10);
    }

    if (DATE_TIME.has(t)) {
        return splitTimestamp(text);
    }

    if (TIME_ONLY.has(t)) {
        const [main, fraction] = splitFraction(text);
        return (
            <>
                {main}
                {fraction && <span className="sub">{fraction}</span>}
            </>
        );
    }

    return text.length > 300 ? text.slice(0, 300) + "…" : text;
}

// "2026-07-22T20:27:03.1717949" -> "2026-07-22 20:27:03" + soluk ".1717949"
function splitTimestamp(text: string): ReactNode {
    const t = text.indexOf("T");
    if (t < 0) {
        return text;
    }

    const date = text.slice(0, t);
    const [time, fraction] = splitFraction(text.slice(t + 1));
    return (
        <>
            {date} {time}
            {fraction && <span className="sub">{fraction}</span>}
        </>
    );
}

// Saniye altı kısmı ve varsa saat dilimi ekini ayırır.
function splitFraction(time: string): [string, string] {
    const dot = time.indexOf(".");
    if (dot < 0) {
        return [time, ""];
    }
    return [time.slice(0, dot), time.slice(dot)];
}

// Sayısal tipler sağa yaslanır; metin ve tarih sola.
const NUMERIC = new Set([
    "bigint", "int", "smallint", "tinyint", "decimal", "numeric",
    "float", "real", "money", "smallmoney", "bit",
]);

export function isNumericType(typeName: string): boolean {
    return NUMERIC.has(typeName.toLowerCase());
}
