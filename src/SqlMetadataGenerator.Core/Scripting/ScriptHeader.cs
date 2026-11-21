using System.Globalization;
using System.Text;

namespace SqlMetadataGenerator.Scripting;

// The block at the top of a generated script: where it was read from, when, what is in it and
// how it was written.
//
// A script found in a ticket or a folder a month later says nothing about its origin. The server
// and the time answer "which environment, how old". The collation matters more than it looks:
// columns that use the database default are written without COLLATE, so on a database with a
// different default they come out different, and only this line says so.
public static class ScriptHeader
{
    // What the catalog says about the source. Read in one round trip with the collation the
    // scripters need anyway.
    public sealed record Source(
        string ProductVersion,
        string Edition,
        int EngineEdition,
        string? Collation,
        int? CompatibilityLevel,
        string Database);

    private const int Width = 70;

    // A script made by the picker: what is in it is what the bundle holds.
    //
    // server: the address from the connection, not its alias. The alias is a name on one
    // person's machine and means nothing to whoever reads the script.
    public static string Write(
        string server,
        Source source,
        ScriptBundle.Result bundle,
        ScriptFormat format,
        bool dataOnly,
        DateTimeOffset generated,
        TimeSpan took)
    {
        var counts = bundle.Items
            .GroupBy(i => i.Kind, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.Count(), StringComparer.OrdinalIgnoreCase);
        bool hasRows = counts.ContainsKey(ScriptBundle.DataKind);
        string output = dataOnly ? "data only" : hasRows ? "DDL + data" : "DDL only";
        return Write(server, source, counts, format, output, generated, took);
    }

    // counts: objects per kind (the picker's kinds, plus ScriptBundle.DataKind for the tables
    // whose rows are in it). output: how the script was asked for, the first word of Options.
    public static string Write(
        string server,
        Source source,
        IReadOnlyDictionary<string, int> counts,
        ScriptFormat format,
        string output,
        DateTimeOffset generated,
        TimeSpan took)
    {
        var lines = new List<(string Label, string Text)>
        {
            ("Server", $"{server} · {Product(source)}"),
            ("Database", Database(source)),
            ("Generated", generated.ToString("yyyy-MM-dd HH:mm:ss zzz", CultureInfo.InvariantCulture) + " · took " + Duration(took)),
            ("Contents", Contents(counts)),
            ("Options", Options(output, format)),
        };

        var text = new StringBuilder();
        string rule = "-- " + new string('=', Width);
        text.Append(rule).Append('\n');
        foreach (var (label, value) in lines)
        {
            text.Append("-- ").Append(label.PadRight(12)).Append(value).Append('\n');
        }
        text.Append(rule).Append('\n');
        return text.ToString();
    }

    // "SQL Server 2022 (16.0.4225.2) Developer Edition". The year is what people say; the build
    // number is what decides whether a feature is there.
    private static string Product(Source s)
    {
        string edition = s.Edition.Replace(" (64-bit)", string.Empty).Trim();
        switch (s.EngineEdition)
        {
            case 5:
                return $"Azure SQL Database ({s.ProductVersion})";
            case 8:
                return $"Azure SQL Managed Instance ({s.ProductVersion})";
        }

        string? year = int.TryParse(s.ProductVersion.Split('.')[0], out int major)
            ? major switch
            {
                11 => "2012",
                12 => "2014",
                13 => "2016",
                14 => "2017",
                15 => "2019",
                16 => "2022",
                17 => "2025",
                _ => null,
            }
            : null;

        return year is null
            ? $"SQL Server {s.ProductVersion} {edition}"
            : $"SQL Server {year} ({s.ProductVersion}) {edition}";
    }

    private static string Database(Source s)
    {
        var parts = new List<string> { s.Database };
        if (s.Collation is not null)
        {
            parts.Add("collation " + s.Collation);
        }
        if (s.CompatibilityLevel is { } level)
        {
            parts.Add("compatibility level " + level.ToString(CultureInfo.InvariantCulture));
        }
        return string.Join(" · ", parts);
    }

    // In the order the sections appear in the script.
    private static string Contents(IReadOnlyDictionary<string, int> counts)
    {
        var parts = new List<string>();
        foreach (var (kind, unit) in Units)
        {
            if (counts.TryGetValue(kind, out int n) && n > 0)
            {
                parts.Add(Count(n, unit));
            }
        }
        if (counts.TryGetValue(ScriptBundle.DataKind, out int tables) && tables > 0)
        {
            parts.Add("rows of " + Count(tables, "table"));
        }
        return parts.Count == 0 ? "nothing" : string.Join(" · ", parts);
    }

    // Every choice that changes the text, so the same script can be made again.
    private static string Options(string output, ScriptFormat format)
    {
        return string.Join(" · ",
            output,
            format.KeywordCase == KeywordCase.Upper ? "uppercase keywords" : "lowercase keywords",
            format.EmitSetOptions ? "SET options" : "no SET options",
            format.GroupColumns ? "grouped columns" : "ungrouped columns");
    }

    private static readonly (string Kind, string Unit)[] Units =
    [
        ("schemas", "schema"),
        ("dataTypes", "data type"),
        ("tableTypes", "table type"),
        ("sequences", "sequence"),
        ("tables", "table"),
        ("views", "view"),
        ("functions", "function"),
        ("procedures", "procedure"),
        ("triggers", "trigger"),
        ("synonyms", "synonym"),
    ];

    private static string Count(int n, string unit) =>
        n.ToString("N0", CultureInfo.InvariantCulture) + " " + unit + (n == 1 ? "" : "s");

    private static string Duration(TimeSpan took) =>
        took.TotalSeconds < 60
            ? took.TotalSeconds.ToString("0.0", CultureInfo.InvariantCulture) + " s"
            : $"{(int)took.TotalMinutes}:{took.Seconds:00}";
}
