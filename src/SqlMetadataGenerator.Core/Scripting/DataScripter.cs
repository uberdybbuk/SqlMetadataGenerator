using System.Globalization;
using System.Text;
using Microsoft.Data.SqlClient;
using SqlMetadataGenerator.Exploration;
using SqlMetadataGenerator.Model;

namespace SqlMetadataGenerator.Scripting;

// Rows as INSERT statements.
//
// Everything else in this tool scripts the SHAPE of a database from catalog views. This one reads
// the data itself, which brings two problems the rest of the code never had:
//
//   1. Volume. A log table with eleven million rows is not something to discover halfway through a
//      download. Hence the ceiling below, which FAILS rather than truncating: a script that quietly
//      contains a tenth of a table is worse than no script, because it looks complete.
//
//   2. Literals. A value has to survive the round trip through text exactly. This is the same trap
//      as the Excel clipboard: a datetime2 that loses its sub-second digits, a float that loses a
//      bit, a varbinary written as a string — all of them produce a script that RUNS and loads
//      different data than the source. So the literal is built from the reader's TYPED value and
//      the column's declared type, never from a display string, and an unrecognised type is an
//      error rather than a guess.
//
// The read is still a read: this produces text. Nothing is written to the source database.
public static class DataScripter
{
    // Above this the picker warns and asks for a WHERE. It is not a limit — it is the point where
    // "just tick it" stops being a reasonable thing to do without thinking.
    public const int WarnRows = 1000;

    // The server's ceiling. Generous enough for reference data and seed tables, low enough that a
    // mis-click on a fact table fails in seconds instead of eating the machine's memory.
    public const int MaxRows = 100_000;

    // T-SQL allows at most 1000 rows in one VALUES clause.
    private const int RowsPerStatement = 1000;

    public sealed record Request(string Schema, string Name, string? Where);

    public static async Task<string> ScriptAsync(
        string connectionString,
        TableInfo table,
        string? where,
        ScriptFormat fmt,
        CancellationToken ct = default)
    {
        // Computed columns cannot be inserted, and neither can a rowversion — the server assigns
        // both. Listing them would make every INSERT fail.
        var columns = table.Columns
            .Where(c => !c.IsComputed && !IsRowVersion(c.TypeName))
            .OrderBy(c => c.ColumnId)
            .ToList();

        if (columns.Count == 0)
        {
            return $"-- {table.Name.Schema}.{table.Name.Name}: nothing insertable.\n";
        }

        string qualified = $"{SqlIdentifier.Quote(table.Name.Schema)}.{SqlIdentifier.Quote(table.Name.Name)}";
        string columnList = string.Join(", ", columns.Select(c => SqlIdentifier.Quote(c.Name)));

        // The WHERE is the user's text and is checked by the same guard the preview uses before it
        // ever reaches the server. The column list and table name come from the catalog, not from
        // the request.
        string sql = $"SELECT {columnList} FROM {qualified}"
            + (string.IsNullOrWhiteSpace(where) ? string.Empty : $" WHERE {where}");

        var rows = new List<string>();
        await using (var conn = new SqlConnection(connectionString))
        {
            await conn.OpenAsync(ct);
            await using var cmd = ReadOnlyCommand.Create(conn, sql);
            await using var reader = await cmd.ExecuteReaderAsync(ct);

            var cells = new string[columns.Count];
            while (await reader.ReadAsync(ct))
            {
                if (rows.Count == MaxRows)
                {
                    throw new InvalidOperationException(
                        $"{table.Name.Schema}.{table.Name.Name} has more than {MaxRows:N0} matching rows. "
                        + "Add a WHERE to narrow it down — a partial script would look complete and would not be.");
                }

                for (int i = 0; i < columns.Count; i++)
                {
                    cells[i] = Literal(reader.IsDBNull(i) ? null : reader.GetValue(i), columns[i], table.Name);
                }
                rows.Add(string.Join(", ", cells));
            }
        }

        var text = new StringBuilder();
        text.Append("-- ").Append(table.Name.Schema).Append('.').Append(table.Name.Name)
            .Append(" — ").Append(rows.Count.ToString("N0", CultureInfo.InvariantCulture))
            .Append(rows.Count == 1 ? " row" : " rows");
        if (!string.IsNullOrWhiteSpace(where))
        {
            text.Append(" matching ").Append(where.Trim());
        }
        text.Append('\n');

        if (rows.Count == 0)
        {
            return text.ToString();
        }

        // IDENTITY_INSERT is only legal where the table actually has an identity column, and only
        // one table per session may have it on — so it is turned off again immediately.
        bool identity = columns.Any(c => c.IsIdentity);
        if (identity)
        {
            text.Append(fmt.Kw("SET")).Append(' ').Append(fmt.Kw("IDENTITY_INSERT")).Append(' ')
                .Append(qualified).Append(' ').Append(fmt.Kw("ON")).Append(";\n").Append(fmt.Kw("GO")).Append("\n\n");
        }

        for (int start = 0; start < rows.Count; start += RowsPerStatement)
        {
            var chunk = rows.Skip(start).Take(RowsPerStatement).ToList();
            text.Append(fmt.Kw("INSERT")).Append(' ').Append(fmt.Kw("INTO")).Append(' ')
                .Append(qualified).Append(" (").Append(columnList).Append(")\n")
                .Append(fmt.Kw("VALUES")).Append('\n');
            for (int i = 0; i < chunk.Count; i++)
            {
                text.Append("    (").Append(chunk[i]).Append(i == chunk.Count - 1 ? ");\n" : "),\n");
            }
            text.Append(fmt.Kw("GO")).Append("\n\n");
        }

        if (identity)
        {
            text.Append(fmt.Kw("SET")).Append(' ').Append(fmt.Kw("IDENTITY_INSERT")).Append(' ')
                .Append(qualified).Append(' ').Append(fmt.Kw("OFF")).Append(";\n").Append(fmt.Kw("GO")).Append('\n');
        }

        return text.ToString();
    }

    // Parent rows before child rows.
    //
    // The DDL order is alphabetical within a kind, which is fine for CREATE TABLE (foreign keys go
    // at the end of each table's own script) but wrong for data: an INSERT into a child fails while
    // its parent is still empty. So the selected tables are sorted by their references.
    //
    // Cycles are real — a self-reference, or two tables pointing at each other — and NO order fixes
    // them. When one is found the caller is told, and it turns the constraints off around the whole
    // load rather than pretending an order exists.
    public static (List<TableInfo> Ordered, bool HasCycle) SortByDependency(IReadOnlyList<TableInfo> tables)
    {
        string KeyOf(ObjectName name) => $"{name.Schema}.{name.Name}";

        var byName = new Dictionary<string, TableInfo>(StringComparer.OrdinalIgnoreCase);
        foreach (var t in tables)
        {
            byName[KeyOf(t.Name)] = t;
        }

        var ordered = new List<TableInfo>();
        var placed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var visiting = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        bool cycle = false;

        void Visit(TableInfo table)
        {
            string key = KeyOf(table.Name);
            if (placed.Contains(key))
            {
                return;
            }
            if (!visiting.Add(key))
            {
                // Reached a table that is still on the stack above us: a back edge, so a cycle.
                cycle = true;
                return;
            }

            foreach (var fk in table.ForeignKeys)
            {
                string parent = KeyOf(fk.ReferencedTable);
                if (string.Equals(parent, key, StringComparison.OrdinalIgnoreCase))
                {
                    // A self-reference. No ordering of TABLES helps; the rows inside this one
                    // point at each other.
                    cycle = true;
                    continue;
                }
                // A reference to a table that was NOT selected is somebody else's problem: those
                // parent rows either already exist on the target or the script will say so.
                if (byName.TryGetValue(parent, out var referenced))
                {
                    Visit(referenced);
                }
            }

            visiting.Remove(key);
            placed.Add(key);
            ordered.Add(table);
        }

        foreach (var table in tables)
        {
            Visit(table);
        }

        // A cycle leaves its members unplaced on the path that detected it; they are appended in
        // input order, which is as good as any when no order is correct.
        foreach (var table in tables)
        {
            if (placed.Add(KeyOf(table.Name)))
            {
                ordered.Add(table);
            }
        }

        return (ordered, cycle);
    }

    private static bool IsRowVersion(string typeName) =>
        typeName.Equals("timestamp", StringComparison.OrdinalIgnoreCase)
        || typeName.Equals("rowversion", StringComparison.OrdinalIgnoreCase);

    // The value as T-SQL source text. Built from the typed value, never from ToString() on
    // something already formatted for a screen.
    private static string Literal(object? value, ColumnInfo column, ObjectName table)
    {
        if (value is null || value is DBNull)
        {
            return "null";
        }

        switch (column.TypeName.ToLowerInvariant())
        {
            case "bit":
                return (bool)value ? "1" : "0";

            case "tinyint":
            case "smallint":
            case "int":
            case "bigint":
                return Convert.ToString(value, CultureInfo.InvariantCulture) ?? "null";

            case "decimal":
            case "numeric":
            case "money":
            case "smallmoney":
                return ((decimal)value).ToString(CultureInfo.InvariantCulture);

            // G17 and G9 are the shortest forms that round-trip a double and a float exactly.
            // Anything shorter changes the number.
            case "float":
                return ((double)value).ToString("G17", CultureInfo.InvariantCulture);
            case "real":
                return ((float)value).ToString("G9", CultureInfo.InvariantCulture);

            case "char":
            case "varchar":
            case "text":
                return Quoted(Convert.ToString(value, CultureInfo.InvariantCulture)!, unicode: false);

            case "nchar":
            case "nvarchar":
            case "ntext":
            case "xml":
                return Quoted(Convert.ToString(value, CultureInfo.InvariantCulture)!, unicode: true);

            case "date":
                return Quoted(((DateTime)value).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), false);

            case "time":
                return Quoted(((TimeSpan)value).ToString(@"hh\:mm\:ss\.fffffff", CultureInfo.InvariantCulture), false);

            // ISO 8601 with the 'T': unambiguous under every language and DATEFORMAT setting.
            case "datetime":
            case "datetime2":
            case "smalldatetime":
                return Quoted(((DateTime)value).ToString("yyyy-MM-ddTHH:mm:ss.fffffff", CultureInfo.InvariantCulture), false);

            case "datetimeoffset":
                return Quoted(((DateTimeOffset)value).ToString("yyyy-MM-ddTHH:mm:ss.fffffffzzz", CultureInfo.InvariantCulture), false);

            case "uniqueidentifier":
                return Quoted(((Guid)value).ToString(), false);

            case "binary":
            case "varbinary":
            case "image":
                return "0x" + Convert.ToHexString((byte[])value);

            default:
                // Spatial types, hierarchyid, sql_variant, a CLR type, an alias type over any of
                // them. Refused by name rather than guessed at: a wrong literal here is a script
                // that runs and loads the wrong thing.
                throw new InvalidOperationException(
                    $"{table.Schema}.{table.Name}.{column.Name} is '{column.TypeName}', which this "
                    + "tool cannot write as a literal. Untick its data, or exclude the column with a WHERE-limited selection.");
        }
    }

    private static string Quoted(string text, bool unicode) =>
        (unicode ? "N'" : "'") + text.Replace("'", "''") + "'";
}
