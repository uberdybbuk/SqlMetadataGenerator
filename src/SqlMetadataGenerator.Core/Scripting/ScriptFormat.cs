namespace SqlMetadataGenerator.Scripting;

public enum KeywordCase
{
    Lower,
    Upper,
}

// Formatting options for the generated script: keyword casing and whether the
// SET ANSI_NULLS / QUOTED_IDENTIFIER blocks are written.
public sealed class ScriptFormat
{
    public KeywordCase KeywordCase { get; init; } = KeywordCase.Lower;
    public bool EmitSetOptions { get; init; }

    // The database default collation. COLLATE is omitted for columns that already match it.
    // When null (it could not be read) collation is always written, to stay on the safe side.
    public string? DatabaseCollation { get; init; }

    // Audit columns. When a table holds a consecutive run (>= 2) of them,
    // a blank line is inserted before and after the run so it reads as its own block.
    // When enabled, consecutive non-audit columns are grouped while they share a word, and
    // groups of at least 2 columns get a blank line before and after them.
    public bool GroupColumns { get; init; } = true;

    public IReadOnlySet<string> AuditColumns { get; init; } = DefaultAuditColumns;

    public static readonly IReadOnlySet<string> DefaultAuditColumns =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "CreatedAt", "CreatedBy", "IsActive",
            "UpdatedAt", "UpdatedBy", "UpdatedCorrelationId", "UpdatedChannelCode",
        };

    // Returns a keyword in the configured casing.
    public string Kw(string keyword) =>
        KeywordCase == KeywordCase.Upper
            ? keyword.ToUpperInvariant()
            : keyword.ToLowerInvariant();
}
