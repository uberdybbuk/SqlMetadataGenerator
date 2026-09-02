using System.Text;
using SqlMetadataGenerator.Model;

namespace SqlMetadataGenerator.Scripting;

// Emits CREATE TYPE ... AS TABLE T-SQL for table types.
// The column body is shared with TableScripter; constraint names are omitted (system-generated).
public static class TableTypeScripter
{
    public static string Script(TableTypeInfo type, ScriptFormat fmt)
    {
        string name = $"{SqlIdentifier.Quote(type.Name.Schema)}.{SqlIdentifier.Quote(type.Name.Name)}";

        var sb = new StringBuilder();
        sb.AppendLine($"{fmt.Kw("CREATE TYPE")} {name} {fmt.Kw("AS TABLE")}");
        sb.AppendLine("(");
        sb.AppendLine(TableScripter.BuildColumnBody(
            type.Columns, type.PrimaryKey, type.UniqueConstraints, fmt, includeConstraintNames: false));
        sb.AppendLine(")");
        sb.AppendLine("GO");
        return sb.ToString();
    }
}
