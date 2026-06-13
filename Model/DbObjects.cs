namespace SqlMetadataGenerator.Model;

/// <summary>Bir tablo veya view'ı tanımlayan şema + ad çifti.</summary>
public sealed record ObjectName(string Schema, string Name)
{
    public override string ToString() => $"[{Schema}].[{Name}]";

    /// <summary>Dosya adı için "schema.name" biçimi (uzantısız).</summary>
    public string FileBaseName => $"{Schema}.{Name}";
}

public sealed class ColumnInfo
{
    public required string Name { get; init; }
    public required int ColumnId { get; init; }
    public required string TypeName { get; init; }
    public required bool IsUserDefinedType { get; init; }
    public required short MaxLength { get; init; }
    public required byte Precision { get; init; }
    public required byte Scale { get; init; }
    public required bool IsNullable { get; init; }
    public required bool IsIdentity { get; init; }
    public long? IdentitySeed { get; init; }
    public long? IdentityIncrement { get; init; }
    public bool IsComputed { get; init; }
    public string? ComputedDefinition { get; init; }
    public string? DefaultConstraintName { get; init; }
    public string? DefaultDefinition { get; init; }
    public string? CollationName { get; init; }
}

public sealed class PrimaryKeyInfo
{
    public required string Name { get; init; }
    public required bool IsClustered { get; init; }
    /// <summary>Kolon adı + azalan mı bilgisi, key sırasına göre.</summary>
    public required List<(string Column, bool Descending)> Columns { get; init; }
}

public sealed class IndexInfo
{
    public required string Name { get; init; }
    public required bool IsUnique { get; init; }
    public required bool IsClustered { get; init; }
    public required List<(string Column, bool Descending)> KeyColumns { get; init; }
    public required List<string> IncludedColumns { get; init; }
    /// <summary>Filtered index ise WHERE koşulu, aksi hâlde null.</summary>
    public string? FilterDefinition { get; init; }
}

public sealed class ForeignKeyInfo
{
    public required string Name { get; init; }
    public required List<string> Columns { get; init; }
    public required ObjectName ReferencedTable { get; init; }
    public required List<string> ReferencedColumns { get; init; }
    /// <summary>sys action desc: NO_ACTION | CASCADE | SET_NULL | SET_DEFAULT.</summary>
    public required string DeleteAction { get; init; }
    public required string UpdateAction { get; init; }
    public required bool IsDisabled { get; init; }
    public required bool IsNotTrusted { get; init; }
    public required bool IsNotForReplication { get; init; }
}

public sealed class UniqueConstraintInfo
{
    public required string Name { get; init; }
    public required bool IsClustered { get; init; }
    public required List<(string Column, bool Descending)> Columns { get; init; }
}

public sealed class CheckConstraintInfo
{
    public required string Name { get; init; }
    /// <summary>sys.check_constraints.definition — koşul (kendi parantezini içerir).</summary>
    public required string Definition { get; init; }
    public required bool IsDisabled { get; init; }
    public required bool IsNotTrusted { get; init; }
    public required bool IsNotForReplication { get; init; }
}

public sealed class TableInfo
{
    public required ObjectName Name { get; init; }
    public required List<ColumnInfo> Columns { get; init; }
    public PrimaryKeyInfo? PrimaryKey { get; init; }
    public List<UniqueConstraintInfo> UniqueConstraints { get; init; } = [];
    public List<IndexInfo> Indexes { get; init; } = [];
    public List<CheckConstraintInfo> CheckConstraints { get; init; } = [];
    public List<ForeignKeyInfo> ForeignKeys { get; init; } = [];
}

/// <summary>
/// Modül başlığı: tanım çekmeden önce hafif kimlik bilgisi. Incremental karşılaştırma için
/// ModifyDate, paketli definition sorgusu için ObjectId kullanılır.
/// </summary>
public sealed class ModuleHeader
{
    public required int ObjectId { get; init; }
    public required ObjectName Name { get; init; }
    public required string CategoryFolder { get; init; }
    public required DateTime ModifyDate { get; init; }
}

/// <summary>
/// sys.sql_modules tabanlı nesneler (view, stored procedure, function, trigger).
/// Tanım sunucudan tam CREATE metni olarak gelir; hedef klasör nesnenin türüne göre belirlenir.
/// </summary>
public sealed class RoutineInfo
{
    public required ObjectName Name { get; init; }
    public required string Definition { get; init; }
    /// <summary>Hedef alt klasör, ör. "Programmability/Stored Procedures".</summary>
    public required string CategoryFolder { get; init; }
}

public sealed class SynonymInfo
{
    public required ObjectName Name { get; init; }
    /// <summary>sys.synonyms.base_object_name — hedef nesnenin (çok parçalı) adı.</summary>
    public required string BaseObjectName { get; init; }
}
