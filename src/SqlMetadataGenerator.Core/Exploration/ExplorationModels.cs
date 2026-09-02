namespace SqlMetadataGenerator.Exploration;

public sealed class ServerInfo
{
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
    public required string RecoveryModel { get; init; }
    public required byte CompatibilityLevel { get; init; }
    // Can be null for offline databases.
    public string? Collation { get; init; }
    public required DateTime CreateDate { get; init; }
    public required long DataMb { get; init; }
    public required long LogMb { get; init; }
    // Only ONLINE databases can be entered.
    public bool IsBrowsable => State.Equals("ONLINE", StringComparison.OrdinalIgnoreCase);
}

// A row behind the treemap. RowCount and the sizes come from catalog views (no scan),
// so they are approximate; the UI should show them with a "~".
public sealed class TableStats
{
    public required string Schema { get; init; }
    public required string Name { get; init; }
    public required long RowCount { get; init; }
    public required long ReservedKb { get; init; }
    public required long UsedKb { get; init; }
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
