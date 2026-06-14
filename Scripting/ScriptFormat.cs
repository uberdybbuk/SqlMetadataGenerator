namespace SqlMetadataGenerator.Scripting;

public enum KeywordCase
{
    Lower,
    Upper,
}

/// <summary>
/// Üretilen script'in biçim ayarları: anahtar kelime büyük/küçük harf tercihi ve
/// SET ANSI_NULLS / QUOTED_IDENTIFIER bloklarının yazılıp yazılmayacağı.
/// </summary>
public sealed class ScriptFormat
{
    public KeywordCase KeywordCase { get; init; } = KeywordCase.Lower;
    public bool EmitSetOptions { get; init; }

    /// <summary>
    /// Veritabanının varsayılan collation'ı. Bir kolonun collation'ı buna eşitse COLLATE yazılmaz.
    /// null ise (okunamadıysa) güvenli tarafta kalmak için collation her zaman yazılır.
    /// </summary>
    public string? DatabaseCollation { get; init; }

    /// <summary>
    /// Audit kolonları. Bir tabloda bunlardan ardışık (>= 2) bir grup varsa,
    /// o grubun öncesine ve sonrasına boş satır eklenerek ayrı bir blok gibi yazılır.
    /// </summary>
    /// <summary>
    /// Açıksa, audit olmayan ardışık kolonlar ortak kelime paylaştıkça gruplanır ve
    /// (en az 2 kolonluk) grupların öncesine/sonrasına boş satır eklenir.
    /// </summary>
    public bool GroupColumns { get; init; } = true;

    public IReadOnlySet<string> AuditColumns { get; init; } = DefaultAuditColumns;

    public static readonly IReadOnlySet<string> DefaultAuditColumns =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "CreatedAt", "CreatedBy", "IsActive",
            "UpdatedAt", "UpdatedBy", "UpdatedCorrelationId", "UpdatedChannelCode",
        };

    /// <summary>Bir anahtar kelimeyi seçili büyük/küçük harf tercihine göre döndürür.</summary>
    public string Kw(string keyword) =>
        KeywordCase == KeywordCase.Upper
            ? keyword.ToUpperInvariant()
            : keyword.ToLowerInvariant();
}
