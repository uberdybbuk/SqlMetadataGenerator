import { formatCellText } from "./cell";
import type { ResultColumn } from "./ResultGrid";

// Excel'e yapıştırma.
//
// Düz metin (TSV) tek başına yeterli değil: Excel her hücreyi kendi kurallarına
// göre YORUMLAR ve sessizce bozar.
//   - "2026-03-15 06:53:51.7400000" yerel ayara göre başka bir tarihe döner ya da
//     saniye altı kısmı atılır; Türkçe Excel'de "15.03.2026" olarak görünür.
//   - "00123" gibi kodların baştaki sıfırları uçar.
//   - 16+ haneli bir bigint bilimsel gösterime düşer ve DEĞERİ değişir.
//
// Çözüm: panoya ayrıca text/html konur. Excel HTML'i tercih eder ve
// mso-number-format ile hücre biçimini dinler. Varsayılan olarak her hücreyi
// METİN ('\@') işaretliyoruz — ekranda ne görüyorsan Excel'e o gidiyor.
// Yalnızca Excel'in kayıpsız tutabileceği sayılar gerçek sayı olarak gider.

const TEXT_FORMAT = String.raw`mso-number-format:'\@'`;

// Excel çift duyarlıklı sayı tutar: 15 anlamlı haneden sonrası bozulur.
const MAX_SAFE_DIGITS = 15;

const NUMERIC_TYPES = new Set([
    "int", "smallint", "tinyint", "decimal", "numeric", "float", "real", "money", "smallmoney",
]);

// bigint bilerek listede yok: kimlik değerleri 15 haneyi aşabiliyor ve
// aşınca Excel sayıyı yuvarlıyor. Metin olarak gitmesi daha güvenli.
function isSafeNumber(value: string | number | boolean | null, typeName: string): boolean {
    if (value === null || typeof value === "boolean") {
        return false;
    }
    if (!NUMERIC_TYPES.has(typeName.toLowerCase())) {
        return false;
    }
    const digits = String(value).replace(/[^0-9]/g, "");
    return digits.length > 0 && digits.length <= MAX_SAFE_DIGITS;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

export interface CopyRegion {
    columns: ResultColumn[];
    // Satır başına, columns ile aynı sıradaki değerler.
    rows: (string | number | boolean | null)[][];
    includeHeader: boolean;
}

// Ekranda görünen biçim panoya da gider; kullanıcı bir tarih görüp başka bir
// tarih yapıştırmasın. NULL açıkça yazılır — Excel'de boş hücre ile "değer yok"
// aynı şey değil.
function asText(value: string | number | boolean | null, typeName: string): string {
    return formatCellText(value, typeName);
}

export function buildPlainText({ columns, rows, includeHeader }: CopyRegion): string {
    const lines = rows.map((row) => row.map((v, i) => asText(v, columns[i].typeName)).join("\t"));
    return (includeHeader ? [columns.map((c) => c.name).join("\t"), ...lines] : lines).join("\n");
}

export function buildHtml({ columns, rows, includeHeader }: CopyRegion): string {
    const head = includeHeader
        ? `<tr>${columns.map((c) => `<th>${escapeHtml(c.name)}</th>`).join("")}</tr>`
        : "";

    const body = rows
        .map(
            (row) =>
                `<tr>${row
                    .map((value, i) => {
                        const style = isSafeNumber(value, columns[i].typeName) ? "" : ` style="${TEXT_FORMAT}"`;
                        return `<td${style}>${escapeHtml(asText(value, columns[i].typeName))}</td>`;
                    })
                    .join("")}</tr>`,
        )
        .join("");

    return `<table>${head}${body}</table>`;
}
