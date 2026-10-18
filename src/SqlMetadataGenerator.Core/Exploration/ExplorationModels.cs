namespace SqlMetadataGenerator.Exploration;

public sealed class ServerInfo
{
    // Which engine this is. The page used to say "SQL Server" in fixed copy, which stops being
    // true the moment a second provider exists.
    public required string Product { get; init; }
    public required string ProductVersion { get; init; }
    public required string ProductLevel { get; init; }
    public required string Edition { get; init; }
    public required string Collation { get; init; }
    public required string MachineName { get; init; }
}

// A row of the server dashboard. The sizes come from sys.master_files: these are the ALLOCATED
// file sizes, not the space in use. The used/free split is computed once you enter the database.
public sealed class DatabaseInfo
{
    public required string Name { get; init; }
    public required string State { get; init; }
    // Null where the engine has no such notion. PostgreSQL has no recovery model, no
    // compatibility level and records no creation date for a database; inventing a value for
    // those would be worse than a dash on the screen.
    public string? RecoveryModel { get; init; }
    public byte? CompatibilityLevel { get; init; }
    // Can be null for offline databases.
    public string? Collation { get; init; }
    public DateTime? CreateDate { get; init; }
    public required long DataMb { get; init; }
    // Null on PostgreSQL: the write-ahead log is one cluster-wide thing, not a per-database file,
    // so a number here would be an invented one.
    public long? LogMb { get; init; }
    // Only ONLINE databases can be entered.
    public bool IsBrowsable => State.Equals("ONLINE", StringComparison.OrdinalIgnoreCase);
}

// A row behind the treemap. RowCount and the sizes come from catalog views (no scan),
// so they are approximate; the UI should show them with a "~".
public sealed class TableStats
{
    public required string Schema { get; init; }
    public required string Name { get; init; }
    // Null means UNKNOWN, not empty. sys.partitions always has an exact count; pg_class.reltuples
    // is -1 until the table is first analysed, and a freshly restored database has no estimate for
    // anything. Reporting that as 0 would tell the scripting panel a large table is safe to dump.
    public required long? RowCount { get; init; }
    public required long ReservedKb { get; init; }
    public required long UsedKb { get; init; }
}

// One row of an object list (views, procedures, triggers ...). The dashboard counters and this
// list come from the same catalog query and the same type mapping, so a badge reading
// "9 synonyms" always opens a list of exactly nine.
public sealed class ObjectSummary
{
    public required string Schema { get; init; }
    public required string Name { get; init; }
    // sys.objects.type_desc, e.g. SQL_STORED_PROCEDURE — it separates the four function kinds
    // that the counter lumps together.
    public required string TypeDesc { get; init; }
    // The table a trigger hangs off; null for everything else.
    public string? Parent { get; init; }
    public required DateTime CreateDate { get; init; }
    public required DateTime ModifyDate { get; init; }
}

// One key column of an index, in key order. Direction matters when the index is being matched
// against an ORDER BY, which is why it travels with the name rather than being flattened away.
public sealed class IndexColumn
{
    public required string Name { get; init; }
    public required bool Descending { get; init; }
}

// A rowstore index on a table. Heaps have no row here; the primary key does, flagged as such,
// because it is an index like any other once you are reasoning about which one a query can use.
public sealed class IndexSummary
{
    public required string Name { get; init; }
    // CLUSTERED or NONCLUSTERED.
    public required string TypeDesc { get; init; }
    public required bool IsUnique { get; init; }
    public required bool IsPrimaryKey { get; init; }
    public required bool IsUniqueConstraint { get; init; }
    // The WHERE of a filtered index; null otherwise.
    public string? Filter { get; init; }
    public required List<IndexColumn> KeyColumns { get; init; }
    public required List<string> IncludedColumns { get; init; }
}

// What the detail tab shows beyond the columns: when the table was made, who owns it, and how it
// is indexed. SQL Server does not record who CREATED an object — the catalog only knows the
// owner, which is the object's own principal when one is set and the schema's otherwise.
public sealed class TableFacts
{
    // Null on PostgreSQL, which records no creation or modification time for a table. The detail
    // tab already renders these only when present.
    public DateTime? CreateDate { get; init; }
    public DateTime? ModifyDate { get; init; }
    public required string Owner { get; init; }
    public required List<IndexSummary> Indexes { get; init; }
}

// A column of a free-form query result. There is no catalog row behind it: the name and type come
// from the reader, because a projection can be an expression that exists in no table.
public sealed class QueryColumn
{
    public required string Name { get; init; }
    public required string TypeName { get; init; }
}

public sealed class QueryResult
{
    public required List<QueryColumn> Columns { get; init; }
    public required List<object?[]> Rows { get; init; }
    public required string Sql { get; init; }
    public required long ElapsedMs { get; init; }
    public required List<string> Messages { get; init; }
    // True when the reader stopped at the row cap and the query had more to give.
    public required bool Capped { get; init; }
}

// One object's DDL, for the detail page. Definition is the server's own CREATE text for anything
// backed by sys.sql_modules; for synonyms, sequences and table types the catalog stores the parts
// rather than a statement, so the Scripting layer composes one and Generated says so — the reader
// should know whether they are looking at what the database holds or at what this tool would write.
public sealed class ObjectDetail
{
    public required string Schema { get; init; }
    public required string Name { get; init; }
    public required string TypeDesc { get; init; }
    public required string Definition { get; init; }
    public required bool Generated { get; init; }
    public required DateTime CreateDate { get; init; }
    public required DateTime ModifyDate { get; init; }
}

// A table's identity plus all of its column metadata — read in a single query.
public sealed class TableShape
{
    public required int ObjectId { get; init; }
    public required string Schema { get; init; }
    public required string Name { get; init; }
    public required List<ColumnSummary> Columns { get; init; }
}

public sealed class PreviewColumn
{
    // The full column metadata travels with the result, so the header info card
    // waits on no separate request.
    public required ColumnSummary Column { get; init; }
    // True when the value really was cut in this preview.
    public required bool Truncated { get; init; }

    public string Name => Column.Name;
    public string TypeName => Column.TypeName;
}

public sealed class PreviewResult
{
    public required List<PreviewColumn> Columns { get; init; }
    // The values per row, in column order; nulls are preserved.
    public required List<object?[]> Rows { get; init; }
    // The query that actually ran. Shown to the user so that how the preview was produced —
    // including where the truncation comes from — stays visible.
    public required string Sql { get; init; }
    // The time from sending the command to reading the last row —
    // that is, the round trip between the application and the database.
    public required long ElapsedMs { get; init; }
    // The informational messages the server returned (PRINT, warnings). These are not errors;
    // errors surface as exceptions.
    public required List<string> Messages { get; init; }
}

// A column row on the table detail page. For DISPLAY, not for script generation —
// full DDL generation is the job of the Scripting/ layer.
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
    // Whether this column is part of the primary key (the key ordinal; null when it is not).
    public int? PrimaryKeyOrdinal { get; init; }
}
