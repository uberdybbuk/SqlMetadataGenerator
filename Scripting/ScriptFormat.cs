namespace SqlMetadataGenerator.Scripting;

public enum KeywordCase
{
    Lower,
    Upper,
}

// Üretilen script'in biçim ayarları: anahtar kelime büyük/küçük harf tercihi ve
// SET ANSI_NULLS / QUOTED_IDENTIFIER bloklarının yazılıp yazılmayacağı.
public sealed class ScriptFormat
{
    public KeywordCase KeywordCase { get; init; } = KeywordCase.Lower;
    public bool EmitSetOptions { get; init; }

    // Veritabanının varsayılan collation'ı. Bir kolonun collation'ı buna eşitse COLLATE yazılmaz.
    // null ise (okunamadıysa) güvenli tarafta kalmak için collation her zaman yazılır.
    public string? DatabaseCollation { get; init; }

    // Audit kolonları. Bir tabloda bunlardan ardışık (>= 2) bir grup varsa,
    // o grubun öncesine ve sonrasına boş satır eklenerek ayrı bir blok gibi yazılır.
    // Açıksa, audit olmayan ardışık kolonlar ortak kelime paylaştıkça gruplanır ve
    // (en az 2 kolonluk) grupların öncesine/sonrasına boş satır eklenir.
    public bool GroupColumns { get; init; } = true;

    public IReadOnlySet<string> AuditColumns { get; init; } = DefaultAuditColumns;

    public static readonly IReadOnlySet<string> DefaultAuditColumns =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "CreatedAt", "CreatedBy", "IsActive",
            "UpdatedAt", "UpdatedBy", "UpdatedCorrelationId", "UpdatedChannelCode",
        };

    // Bir anahtar kelimeyi seçili büyük/küçük harf tercihine göre döndürür.
    public string Kw(string keyword) =>
        KeywordCase == KeywordCase.Upper
            ? keyword.ToUpperInvariant()
            : keyword.ToLowerInvariant();
}
