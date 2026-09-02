using System.Text;
using SqlMetadataGenerator.Model;

namespace SqlMetadataGenerator.Scripting;

// Emits ALTER TABLE ... ADD CONSTRAINT ... CHECK T-SQL for check constraints.
// Same order as foreign keys: add the constraint first, then apply the CHECK/NOCHECK state in a separate ALTER.
public static class CheckConstraintScripter
{
    public static string Script(ObjectName table, CheckConstraintInfo check, ScriptFormat fmt)
    {
        string tableName = $"{SqlIdentifier.Quote(table.Schema)}.{SqlIdentifier.Quote(table.Name)}";
        string withCheck = check.IsNotTrusted ? fmt.Kw("WITH NOCHECK") : fmt.Kw("WITH CHECK");
        string notForRepl = check.IsNotForReplication ? $" {fmt.Kw("NOT FOR REPLICATION")}" : string.Empty;

        var sb = new StringBuilder();
        // definition brings its own parentheses (e.g. "([Age]>(0))").
        sb.AppendLine($"{fmt.Kw("ALTER TABLE")} {tableName}");
        sb.AppendLine($"{withCheck} {fmt.Kw("ADD CONSTRAINT")} {SqlIdentifier.Quote(check.Name)}");
        sb.AppendLine($"{fmt.Kw("CHECK")}{notForRepl} {check.Definition}");
        sb.AppendLine("GO");

        // The second ALTER is only needed when the constraint is disabled (same rule as foreign keys).
        if (check.IsDisabled)
        {
            sb.AppendLine($"{fmt.Kw("ALTER TABLE")} {tableName} {fmt.Kw("NOCHECK CONSTRAINT")} {SqlIdentifier.Quote(check.Name)}");
            sb.AppendLine("GO");
        }

        return sb.ToString();
    }
}
