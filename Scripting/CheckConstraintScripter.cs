using System.Text;
using SqlMetadataGenerator.Model;

namespace SqlMetadataGenerator.Scripting;

// CHECK constraint'ler için ALTER TABLE ... ADD CONSTRAINT ... CHECK T-SQL'i üretir.
// FK'lerde olduğu gibi: önce kısıtı ekle, sonra ayrı ALTER ile CHECK/NOCHECK durumunu uygula.
public static class CheckConstraintScripter
{
    public static string Script(ObjectName table, CheckConstraintInfo check, ScriptFormat fmt)
    {
        string tableName = $"{SqlIdentifier.Quote(table.Schema)}.{SqlIdentifier.Quote(table.Name)}";
        string withCheck = check.IsNotTrusted ? fmt.Kw("WITH NOCHECK") : fmt.Kw("WITH CHECK");
        string notForRepl = check.IsNotForReplication ? $" {fmt.Kw("NOT FOR REPLICATION")}" : string.Empty;

        var sb = new StringBuilder();
        // definition kendi parantezini içerir (ör. "([Age]>(0))").
        sb.AppendLine($"{fmt.Kw("ALTER TABLE")} {tableName}");
        sb.AppendLine($"{withCheck} {fmt.Kw("ADD CONSTRAINT")} {SqlIdentifier.Quote(check.Name)}");
        sb.AppendLine($"{fmt.Kw("CHECK")}{notForRepl} {check.Definition}");
        sb.AppendLine("GO");

        // İkinci ALTER yalnızca kısıt devre dışıysa gereklidir (FK ile aynı mantık).
        if (check.IsDisabled)
        {
            sb.AppendLine($"{fmt.Kw("ALTER TABLE")} {tableName} {fmt.Kw("NOCHECK CONSTRAINT")} {SqlIdentifier.Quote(check.Name)}");
            sb.AppendLine("GO");
        }

        return sb.ToString();
    }
}
