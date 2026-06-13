using System.Text;
using SqlMetadataGenerator.Model;

namespace SqlMetadataGenerator.Scripting;

/// <summary>Synonym'ler için CREATE SYNONYM T-SQL'i üretir.</summary>
public static class SynonymScripter
{
    public static string Script(SynonymInfo synonym, ScriptFormat fmt)
    {
        string name = $"{SqlIdentifier.Quote(synonym.Name.Schema)}.{SqlIdentifier.Quote(synonym.Name.Name)}";
        var sb = new StringBuilder();
        // base_object_name çok parçalı bir referanstır ve sunucudan geldiği gibi bırakılır.
        sb.AppendLine($"{fmt.Kw("CREATE SYNONYM")} {name} {fmt.Kw("FOR")} {synonym.BaseObjectName}");
        sb.AppendLine("GO");
        return sb.ToString();
    }
}
