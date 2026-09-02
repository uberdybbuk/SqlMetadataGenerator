using System.Text;
using SqlMetadataGenerator.Model;

namespace SqlMetadataGenerator.Scripting;

// Emits ALTER TABLE ... ADD CONSTRAINT T-SQL for foreign keys.
// Follows the SSMS layout: add the constraint first, then apply the CHECK/NOCHECK state in a separate ALTER.
public static class ForeignKeyScripter
{
    public static string Script(ObjectName table, ForeignKeyInfo fk, ScriptFormat fmt)
    {
        string tableName = $"{SqlIdentifier.Quote(table.Schema)}.{SqlIdentifier.Quote(table.Name)}";
        string refName = $"{SqlIdentifier.Quote(fk.ReferencedTable.Schema)}.{SqlIdentifier.Quote(fk.ReferencedTable.Name)}";
        string cols = string.Join(", ", fk.Columns.Select(SqlIdentifier.Quote));
        string refCols = string.Join(", ", fk.ReferencedColumns.Select(SqlIdentifier.Quote));

        // Untrusted constraints (added WITH NOCHECK and never verified) are scripted WITH NOCHECK.
        string withCheck = fk.IsNotTrusted ? fmt.Kw("WITH NOCHECK") : fmt.Kw("WITH CHECK");

        var sb = new StringBuilder();
        sb.AppendLine($"{fmt.Kw("ALTER TABLE")} {tableName}");
        sb.AppendLine($"{withCheck} {fmt.Kw("ADD CONSTRAINT")} {SqlIdentifier.Quote(fk.Name)}");
        sb.Append($"{fmt.Kw("FOREIGN KEY")} ({cols}) {fmt.Kw("REFERENCES")} {refName} ({refCols})");

        string? onDelete = ReferentialAction(fk.DeleteAction, fmt);
        if (onDelete is not null)
        {
            sb.Append($"\n{fmt.Kw("ON DELETE")} {onDelete}");
        }

        string? onUpdate = ReferentialAction(fk.UpdateAction, fmt);
        if (onUpdate is not null)
        {
            sb.Append($"\n{fmt.Kw("ON UPDATE")} {onUpdate}");
        }

        if (fk.IsNotForReplication)
        {
            sb.Append($"\n{fmt.Kw("NOT FOR REPLICATION")}");
        }

        sb.AppendLine();
        sb.AppendLine("GO");

        // The second ALTER is only needed when the constraint is disabled. The first statement already adds
        // the constraint enabled (and trusted when WITH CHECK), so repeating CHECK CONSTRAINT is normally
        // redundant. NOCHECK CONSTRAINT is written to keep a disabled constraint disabled.
        if (fk.IsDisabled)
        {
            sb.AppendLine($"{fmt.Kw("ALTER TABLE")} {tableName} {fmt.Kw("NOCHECK CONSTRAINT")} {SqlIdentifier.Quote(fk.Name)}");
            sb.AppendLine("GO");
        }

        return sb.ToString();
    }

    // null for NO_ACTION (nothing is written); otherwise "CASCADE" / "SET NULL" / "SET DEFAULT".
    private static string? ReferentialAction(string actionDesc, ScriptFormat fmt)
    {
        if (string.Equals(actionDesc, "NO_ACTION", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        return fmt.Kw(actionDesc.Replace('_', ' '));
    }
}
