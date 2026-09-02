using System.Text;

namespace SqlMetadataGenerator.Scripting;

// Shared script generation for sys.sql_modules objects (view, stored procedure, function, trigger).
// The definition arrives from the server as the full CREATE text, so it is wrapped verbatim.
public static class ModuleScripter
{
    public static string Script(string definition, ScriptFormat fmt)
    {
        var sb = new StringBuilder();
        if (fmt.EmitSetOptions)
        {
            sb.AppendLine(fmt.Kw("SET ANSI_NULLS ON"));
            sb.AppendLine("GO");
            sb.AppendLine(fmt.Kw("SET QUOTED_IDENTIFIER ON"));
            sb.AppendLine("GO");
        }
        sb.AppendLine(definition.TrimEnd());
        sb.AppendLine("GO");
        return sb.ToString();
    }
}
