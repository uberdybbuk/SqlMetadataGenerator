using System.Text;
using SqlMetadataGenerator.Model;

namespace SqlMetadataGenerator.Scripting;

// Sequence'ler için CREATE SEQUENCE T-SQL'i üretir.
public static class SequenceScripter
{
    public static string Script(SequenceInfo seq, ScriptFormat fmt)
    {
        string name = $"{SqlIdentifier.Quote(seq.Name.Schema)}.{SqlIdentifier.Quote(seq.Name.Name)}";

        string cache;
        if (!seq.IsCached)
        {
            cache = fmt.Kw("NO CACHE");
        }
        else if (seq.CacheSize is { } size)
        {
            cache = $"{fmt.Kw("CACHE")} {size}";
        }
        else
        {
            cache = fmt.Kw("CACHE");
        }

        var sb = new StringBuilder();
        sb.AppendLine($"{fmt.Kw("CREATE SEQUENCE")} {name}");
        sb.AppendLine($"\t{fmt.Kw("AS")} {fmt.Kw(seq.TypeName)}");
        sb.AppendLine($"\t{fmt.Kw("START WITH")} {seq.StartValue}");
        sb.AppendLine($"\t{fmt.Kw("INCREMENT BY")} {seq.Increment}");
        sb.AppendLine($"\t{fmt.Kw("MINVALUE")} {seq.MinValue}");
        sb.AppendLine($"\t{fmt.Kw("MAXVALUE")} {seq.MaxValue}");
        sb.AppendLine($"\t{(seq.IsCycling ? fmt.Kw("CYCLE") : fmt.Kw("NO CYCLE"))}");
        sb.AppendLine($"\t{cache}");
        sb.AppendLine("GO");
        return sb.ToString();
    }
}
