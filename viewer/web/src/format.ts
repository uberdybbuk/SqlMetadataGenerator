// Satır sayısı ve boyutlar katalog view'larından gelir; tarama yapılmadığı için
// yaklaşıktır. Gösterimde bunu gizlemiyoruz.
export function formatRows(value: number): string {
    return value.toLocaleString("en-US");
}

export function formatKb(kb: number): string {
    if (kb <= 0) {
        return "—";
    }
    if (kb < 1024) {
        return `${kb} KB`;
    }
    const mb = kb / 1024;
    if (mb < 1024) {
        return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
    }
    return `${(mb / 1024).toFixed(1)} GB`;
}

export function formatMb(mb: number): string {
    if (mb <= 0) {
        return "—";
    }
    return mb < 1024 ? `${mb} MB` : `${(mb / 1024).toFixed(1)} GB`;
}

export function formatDate(iso: string): string {
    return iso.slice(0, 10);
}

// SQL tipini kolon metadatasından okunabilir hâle getirir (nvarchar(max), decimal(18, 2) ...).
export function formatType(
    typeName: string,
    maxLength: number,
    precision: number,
    scale: number,
): string {
    const t = typeName.toLowerCase();
    if (t === "varchar" || t === "char" || t === "varbinary" || t === "binary") {
        return `${t}(${maxLength === -1 ? "max" : maxLength})`;
    }
    if (t === "nvarchar" || t === "nchar") {
        return `${t}(${maxLength === -1 ? "max" : maxLength / 2})`;
    }
    if (t === "decimal" || t === "numeric") {
        return `${t}(${precision}, ${scale})`;
    }
    if (t === "datetime2" || t === "datetimeoffset" || t === "time") {
        return `${t}(${scale})`;
    }
    return t;
}

// "1 procedures" gibi çıktıları önler. Düzensiz çoğullar için ikinci biçim verilir.
export function plural(count: number, singular: string, pluralForm?: string): string {
    return count === 1 ? singular : (pluralForm ?? singular + "s");
}
