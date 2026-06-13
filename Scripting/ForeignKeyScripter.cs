using System.Text;
using SqlMetadataGenerator.Model;

namespace SqlMetadataGenerator.Scripting;

/// <summary>
/// Foreign key'ler için ALTER TABLE ... ADD CONSTRAINT T-SQL'i üretir.
/// SSMS düzenini izler: önce kısıtı ekle, sonra ayrı bir ALTER ile CHECK/NOCHECK durumunu uygula.
/// </summary>
public static class ForeignKeyScripter
{
    public static string Script(ObjectName table, ForeignKeyInfo fk, ScriptFormat fmt)
    {
        string tableName = $"{SqlIdentifier.Quote(table.Schema)}.{SqlIdentifier.Quote(table.Name)}";
        string refName = $"{SqlIdentifier.Quote(fk.ReferencedTable.Schema)}.{SqlIdentifier.Quote(fk.ReferencedTable.Name)}";
        string cols = string.Join(", ", fk.Columns.Select(SqlIdentifier.Quote));
        string refCols = string.Join(", ", fk.ReferencedColumns.Select(SqlIdentifier.Quote));

        // Güvenilmeyen (NOCHECK ile doğrulanmadan eklenmiş) kısıtlar WITH NOCHECK ile script'lenir.
        string withCheck = fk.IsNotTrusted ? fmt.Kw("WITH NOCHECK") : fmt.Kw("WITH CHECK");

        var sb = new StringBuilder();
        sb.AppendLine($"{fmt.Kw("ALTER TABLE")} {tableName}");
        sb.AppendLine($"{withCheck} {fmt.Kw("ADD CONSTRAINT")} {SqlIdentifier.Quote(fk.Name)}");
        sb.Append($"{fmt.Kw("FOREIGN KEY")} ({cols}) {fmt.Kw("REFERENCES")} {refName} ({refCols})");

        string? onDelete = ReferentialAction(fk.DeleteAction, fmt);
        if (onDelete is not null)
            sb.Append($"\n{fmt.Kw("ON DELETE")} {onDelete}");

        string? onUpdate = ReferentialAction(fk.UpdateAction, fmt);
        if (onUpdate is not null)
            sb.Append($"\n{fmt.Kw("ON UPDATE")} {onUpdate}");

        if (fk.IsNotForReplication)
            sb.Append($"\n{fmt.Kw("NOT FOR REPLICATION")}");

        sb.AppendLine();
        sb.AppendLine("GO");

        // İkinci ALTER yalnızca kısıt devre dışıysa gereklidir. İlk ifade kısıtı zaten etkin
        // (ve WITH CHECK ise güvenilir) olarak ekler; bu yüzden normalde CHECK CONSTRAINT
        // tekrarı gereksizdir. Devre dışı kısıtı disable bırakmak için NOCHECK CONSTRAINT yazılır.
        if (fk.IsDisabled)
        {
            sb.AppendLine($"{fmt.Kw("ALTER TABLE")} {tableName} {fmt.Kw("NOCHECK CONSTRAINT")} {SqlIdentifier.Quote(fk.Name)}");
            sb.AppendLine("GO");
        }

        return sb.ToString();
    }

    /// <summary>NO_ACTION ise null (yazılmaz); aksi hâlde "CASCADE" / "SET NULL" / "SET DEFAULT".</summary>
    private static string? ReferentialAction(string actionDesc, ScriptFormat fmt)
    {
        if (string.Equals(actionDesc, "NO_ACTION", StringComparison.OrdinalIgnoreCase))
            return null;
        return fmt.Kw(actionDesc.Replace('_', ' '));
    }
}
