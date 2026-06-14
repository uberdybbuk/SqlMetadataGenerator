using System.Text;
using SqlMetadataGenerator.Model;

namespace SqlMetadataGenerator.Scripting;

// PK/unique-constraint olmayan index'ler için CREATE INDEX T-SQL'i üretir.
// INCLUDE kolonları ve filtered index WHERE koşulu desteklenir.
public static class IndexScripter
{
    public static string Script(ObjectName table, IndexInfo index, ScriptFormat fmt)
    {
        string tableName = $"{SqlIdentifier.Quote(table.Schema)}.{SqlIdentifier.Quote(table.Name)}";
        string unique = index.IsUnique ? fmt.Kw("UNIQUE") + " " : string.Empty;
        string clustered = index.IsClustered ? fmt.Kw("CLUSTERED") : fmt.Kw("NONCLUSTERED");

        var sb = new StringBuilder();
        sb.AppendLine($"{fmt.Kw("CREATE")} {unique}{clustered} {fmt.Kw("INDEX")} " +
                      $"{SqlIdentifier.Quote(index.Name)} {fmt.Kw("ON")} {tableName}");
        sb.AppendLine("(");
        var keyLines = index.KeyColumns.Select(c =>
            $"\t{SqlIdentifier.Quote(c.Column)} {(c.Descending ? fmt.Kw("DESC") : fmt.Kw("ASC"))}");
        sb.AppendLine(string.Join(",\n", keyLines));
        sb.Append(')');

        if (index.IncludedColumns.Count > 0)
        {
            var inc = index.IncludedColumns.Select(SqlIdentifier.Quote);
            sb.AppendLine();
            sb.Append($"{fmt.Kw("INCLUDE")} ({string.Join(", ", inc)})");
        }

        if (index.FilterDefinition is not null)
        {
            sb.AppendLine();
            sb.Append($"{fmt.Kw("WHERE")} {index.FilterDefinition}");
        }

        sb.AppendLine();
        sb.AppendLine("GO");
        return sb.ToString();
    }
}
