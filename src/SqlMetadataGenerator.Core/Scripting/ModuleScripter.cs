using System.Text;

namespace SqlMetadataGenerator.Scripting;

// sys.sql_modules tabanlı nesneler (view, stored procedure, function, trigger) için ortak script üretimi.
// Tanım sunucudan tam CREATE metni olarak geldiği için olduğu gibi sarılır.
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
