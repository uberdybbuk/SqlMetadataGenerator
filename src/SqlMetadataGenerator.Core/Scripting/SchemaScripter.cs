using System.Text;
using SqlMetadataGenerator.Model;

namespace SqlMetadataGenerator.Scripting;

// Emits CREATE SCHEMA T-SQL for schemas.
public static class SchemaScripter
{
    public static string Script(SchemaInfo schema, ScriptFormat fmt)
    {
        string name = SqlIdentifier.Quote(schema.Name);
        var sb = new StringBuilder();

        // AUTHORIZATION is written only when the owner is not dbo; dbo is the default and stays implicit.
        if (!schema.Owner.Equals("dbo", StringComparison.OrdinalIgnoreCase))
        {
            sb.AppendLine($"{fmt.Kw("CREATE SCHEMA")} {name} {fmt.Kw("AUTHORIZATION")} {SqlIdentifier.Quote(schema.Owner)}");
        }
        else
        {
            sb.AppendLine($"{fmt.Kw("CREATE SCHEMA")} {name}");
        }

        sb.AppendLine("GO");
        return sb.ToString();
    }
}
