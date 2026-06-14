using System.Text;
using SqlMetadataGenerator.Model;

namespace SqlMetadataGenerator.Scripting;

// Alias tipleri (User-Defined Data Types) için CREATE TYPE ... FROM T-SQL'i üretir.
public static class UserDefinedTypeScripter
{
    public static string Script(UserDefinedTypeInfo type, ScriptFormat fmt)
    {
        string name = $"{SqlIdentifier.Quote(type.Name.Schema)}.{SqlIdentifier.Quote(type.Name.Name)}";
        string baseType = SqlTypeFormatter.Format(type.BaseTypeName, type.MaxLength, type.Precision, type.Scale, fmt);
        string nullability = type.IsNullable ? fmt.Kw("NULL") : fmt.Kw("NOT NULL");

        var sb = new StringBuilder();
        sb.AppendLine($"{fmt.Kw("CREATE TYPE")} {name} {fmt.Kw("FROM")} {baseType} {nullability}");
        sb.AppendLine("GO");
        return sb.ToString();
    }
}
