using System.Text;
using SqlMetadataGenerator.Model;

namespace SqlMetadataGenerator.Scripting;

// Emits CREATE SYNONYM T-SQL for synonyms.
public static class SynonymScripter
{
    public static string Script(SynonymInfo synonym, ScriptFormat fmt)
    {
        string name = $"{SqlIdentifier.Quote(synonym.Name.Schema)}.{SqlIdentifier.Quote(synonym.Name.Name)}";
        var sb = new StringBuilder();
        // base_object_name is a multi-part reference and is left exactly as the server returned it.
        sb.AppendLine($"{fmt.Kw("CREATE SYNONYM")} {name} {fmt.Kw("FOR")} {synonym.BaseObjectName}");
        sb.AppendLine("GO");
        return sb.ToString();
    }
}
