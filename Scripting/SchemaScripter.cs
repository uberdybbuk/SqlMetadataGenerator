using System.Text;
using SqlMetadataGenerator.Model;

namespace SqlMetadataGenerator.Scripting;

/// <summary>Şemalar için CREATE SCHEMA T-SQL'i üretir.</summary>
public static class SchemaScripter
{
    public static string Script(SchemaInfo schema, ScriptFormat fmt)
    {
        string name = SqlIdentifier.Quote(schema.Name);
        var sb = new StringBuilder();

        // Sahip dbo değilse AUTHORIZATION belirtilir; dbo varsayılandır, yazılmaz.
        if (!schema.Owner.Equals("dbo", StringComparison.OrdinalIgnoreCase))
            sb.AppendLine($"{fmt.Kw("CREATE SCHEMA")} {name} {fmt.Kw("AUTHORIZATION")} {SqlIdentifier.Quote(schema.Owner)}");
        else
            sb.AppendLine($"{fmt.Kw("CREATE SCHEMA")} {name}");

        sb.AppendLine("GO");
        return sb.ToString();
    }
}
