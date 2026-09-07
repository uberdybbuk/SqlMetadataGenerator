namespace SqlMetadataGenerator.Model;

// The schema + name pair that identifies a table or view.
public sealed record ObjectName(string Schema, string Name)
{
    public override string ToString() => $"[{Schema}].[{Name}]";

    // The "schema.name" form used for the file name (without extension).
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
    // The column name plus whether it is descending, in key order.
    public required List<(string Column, bool Descending)> Columns { get; init; }
}

public sealed class IndexInfo
{
    public required string Name { get; init; }
    public required bool IsUnique { get; init; }
    public required bool IsClustered { get; init; }
    public required List<(string Column, bool Descending)> KeyColumns { get; init; }
    public required List<string> IncludedColumns { get; init; }
    // The WHERE predicate when the index is filtered, otherwise null.
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
    // sys.check_constraints.definition — the predicate (it brings its own parentheses).
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

// Module header: lightweight identity read before the definition. ModifyDate drives the
// incremental comparison, ObjectId drives the batched definition query.
public sealed class ModuleHeader
{
    public required int ObjectId { get; init; }
    public required ObjectName Name { get; init; }
    public required string CategoryFolder { get; init; }
    // Filter type: views | procedures | functions | triggers.
    public required string Kind { get; init; }
    public required DateTime ModifyDate { get; init; }
}

// Objects backed by sys.sql_modules (view, stored procedure, function, trigger).
// The definition arrives from the server as the full CREATE text; the target folder follows the object kind.
public sealed class RoutineInfo
{
    public required ObjectName Name { get; init; }
    public required string Definition { get; init; }
    // The target sub-folder, e.g. "Programmability/Stored Procedures".
    public required string CategoryFolder { get; init; }
}

public sealed class SynonymInfo
{
    public required ObjectName Name { get; init; }
    // sys.synonyms.base_object_name — the (multi-part) name of the target object.
    public required string BaseObjectName { get; init; }
}

public sealed class SchemaInfo
{
    public required string Name { get; init; }
    // The schema owner (principal). AUTHORIZATION is omitted for dbo (the default).
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

// Alias type (User-Defined Data Type): a named derivative of a system type.
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
    // The base system type of the sequence (e.g. bigint).
    public required string TypeName { get; init; }
    // The values are sql_variant, so they are kept as type-independent text.
    public required string StartValue { get; init; }
    public required string Increment { get; init; }
    public required string MinValue { get; init; }
    public required string MaxValue { get; init; }
    public required bool IsCycling { get; init; }
    public required bool IsCached { get; init; }
    // The size when caching is on and one is set; null otherwise (the default cache).
    public long? CacheSize { get; init; }
}

// One scriptable object, identified the way the scripting panel addresses it. This is a NAME, not
// a definition: the inventory is read to draw the picker, and only what the user ticks is read in
// full. Kind is the vocabulary shared with the picker and with ScriptBundle's ordering.
//
// Schemas carry their own name in Schema as well as in Name, so that grouping the tree by schema
// puts a schema object under itself rather than under a blank.
public sealed record ScriptableObject(string Kind, string Schema, string Name);
