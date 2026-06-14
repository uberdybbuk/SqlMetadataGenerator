namespace SqlMetadataGenerator.Model;

// Bir tablo veya view'ı tanımlayan şema + ad çifti.
public sealed record ObjectName(string Schema, string Name)
{
    public override string ToString() => $"[{Schema}].[{Name}]";

    // Dosya adı için "schema.name" biçimi (uzantısız).
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
    // Kolon adı + azalan mı bilgisi, key sırasına göre.
    public required List<(string Column, bool Descending)> Columns { get; init; }
}

public sealed class IndexInfo
{
    public required string Name { get; init; }
    public required bool IsUnique { get; init; }
    public required bool IsClustered { get; init; }
    public required List<(string Column, bool Descending)> KeyColumns { get; init; }
    public required List<string> IncludedColumns { get; init; }
    // Filtered index ise WHERE koşulu, aksi hâlde null.
    public string? FilterDefinition { get; init; }
}

public sealed class ForeignKeyInfo
{
    public required string Name { get; init; }
    public required List<string> Columns { get; init; }
    public required ObjectName ReferencedTable { get; init; }
    public required List<string> ReferencedColumns { get; init; }
    // sys action desc: NO_ACTION | CASCADE | SET_NULL | SET_DEFAULT.
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
    // sys.check_constraints.definition — koşul (kendi parantezini içerir).
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

// Modül başlığı: tanım çekmeden önce hafif kimlik bilgisi. Incremental karşılaştırma için
// ModifyDate, paketli definition sorgusu için ObjectId kullanılır.
public sealed class ModuleHeader
{
    public required int ObjectId { get; init; }
    public required ObjectName Name { get; init; }
    public required string CategoryFolder { get; init; }
    // Filtre tipi: views | procedures | functions | triggers.
    public required string Kind { get; init; }
    public required DateTime ModifyDate { get; init; }
}

// sys.sql_modules tabanlı nesneler (view, stored procedure, function, trigger).
// Tanım sunucudan tam CREATE metni olarak gelir; hedef klasör nesnenin türüne göre belirlenir.
public sealed class RoutineInfo
{
    public required ObjectName Name { get; init; }
    public required string Definition { get; init; }
    // Hedef alt klasör, ör. "Programmability/Stored Procedures".
    public required string CategoryFolder { get; init; }
}

public sealed class SynonymInfo
{
    public required ObjectName Name { get; init; }
    // sys.synonyms.base_object_name — hedef nesnenin (çok parçalı) adı.
    public required string BaseObjectName { get; init; }
}

public sealed class SchemaInfo
{
    public required string Name { get; init; }
    // Şema sahibi (principal). dbo ise AUTHORIZATION yazılmaz (varsayılan).
    public required string Owner { get; init; }
}

// Table type (User-Defined Table Type): CREATE TYPE ... AS TABLE.
public sealed class TableTypeInfo
{
    public required ObjectName Name { get; init; }
    public required List<ColumnInfo> Columns { get; init; }
    public PrimaryKeyInfo? PrimaryKey { get; init; }
    public List<UniqueConstraintInfo> UniqueConstraints { get; init; } = [];
}

// Alias tipi (User-Defined Data Type): bir sistem tipinin adlandırılmış türevi.
public sealed class UserDefinedTypeInfo
{
    public required ObjectName Name { get; init; }
    public required string BaseTypeName { get; init; }
    public required short MaxLength { get; init; }
    public required byte Precision { get; init; }
    public required byte Scale { get; init; }
    public required bool IsNullable { get; init; }
}

public sealed class SequenceInfo
{
    public required ObjectName Name { get; init; }
    // Sequence'in temel sistem tipi (ör. bigint).
    public required string TypeName { get; init; }
    // Değerler sql_variant olduğundan tip-bağımsız metin olarak tutulur.
    public required string StartValue { get; init; }
    public required string Increment { get; init; }
    public required string MinValue { get; init; }
    public required string MaxValue { get; init; }
    public required bool IsCycling { get; init; }
    public required bool IsCached { get; init; }
    // Cache açıkken belirli bir boyut varsa; yoksa (varsayılan cache) null.
    public long? CacheSize { get; init; }
}
