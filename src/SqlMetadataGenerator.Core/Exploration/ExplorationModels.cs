namespace SqlMetadataGenerator.Exploration;

public sealed class ServerInfo
{
    public required string ProductVersion { get; init; }
    public required string ProductLevel { get; init; }
    public required string Edition { get; init; }
    public required string Collation { get; init; }
    public required string MachineName { get; init; }
}

// Sunucu dashboard'unun satırı. Boyutlar sys.master_files'tan gelir: bunlar AYRILMIŞ
// dosya boyutudur, kullanılan alan değil. Kullanılan/boş kırılımı DB'ye girince hesaplanır.
public sealed class DatabaseInfo
{
    public required string Name { get; init; }
    public required string State { get; init; }
    public required string RecoveryModel { get; init; }
    public required byte CompatibilityLevel { get; init; }
    // Çevrimdışı veritabanlarında null olabilir.
    public string? Collation { get; init; }
    public required DateTime CreateDate { get; init; }
    public required long DataMb { get; init; }
    public required long LogMb { get; init; }
    // Yalnızca ONLINE veritabanlarına girilebilir.
    public bool IsBrowsable => State.Equals("ONLINE", StringComparison.OrdinalIgnoreCase);
}

// Treemap'i besleyen satır. RowCount ve boyutlar katalog view'larından gelir (tarama yok),
// bu yüzden yaklaşıktır; UI'da "~" ile gösterilmeli.
public sealed class TableStats
{
    public required string Schema { get; init; }
    public required string Name { get; init; }
    public required long RowCount { get; init; }
    public required long ReservedKb { get; init; }
    public required long UsedKb { get; init; }
}

public sealed class PreviewColumn
{
    public required string Name { get; init; }
    public required string TypeName { get; init; }
    // Sunucu tarafında kısaltıldıysa true (büyük metin/binary kolonlar).
    public required bool Truncated { get; init; }
}

public sealed class PreviewResult
{
    public required List<PreviewColumn> Columns { get; init; }
    // Satır başına kolon sırasına göre değerler; null'lar korunur.
    public required List<object?[]> Rows { get; init; }
}

// Tablo detay sayfasının kolon satırı. Script üretimi için değil, GÖSTERİM için —
// tam DDL üretimi Scripting/ katmanının işi.
public sealed class ColumnSummary
{
    public required string Name { get; init; }
    public required int ColumnId { get; init; }
    public required string TypeName { get; init; }
    public required short MaxLength { get; init; }
    public required byte Precision { get; init; }
    public required byte Scale { get; init; }
    public required bool IsNullable { get; init; }
    public required bool IsIdentity { get; init; }
    public required bool IsComputed { get; init; }
    public string? DefaultDefinition { get; init; }
    // Bu kolon birincil anahtarın parçası mı (anahtar sırası; değilse null).
    public int? PrimaryKeyOrdinal { get; init; }
}
