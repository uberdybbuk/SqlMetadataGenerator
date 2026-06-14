using System.Text;
using SqlMetadataGenerator.Model;

namespace SqlMetadataGenerator.Scripting;

// Tablo metadatasından CREATE TABLE T-SQL'i üretir.
// İlk sürüm: kolonlar (tip, identity, computed, nullability, default) + primary key.
// (Foreign key'ler, non-clustered index'ler sonraki adımlarda eklenecek.)
public static class TableScripter
{
    public static string Script(TableInfo table, ScriptFormat fmt)
    {
        var sb = new StringBuilder();
        if (fmt.EmitSetOptions)
        {
            sb.AppendLine(fmt.Kw("SET ANSI_NULLS ON"));
            sb.AppendLine("GO");
            sb.AppendLine(fmt.Kw("SET QUOTED_IDENTIFIER ON"));
            sb.AppendLine("GO");
        }

        string tableName = $"{SqlIdentifier.Quote(table.Name.Schema)}.{SqlIdentifier.Quote(table.Name.Name)}";
        sb.AppendLine($"{fmt.Kw("CREATE TABLE")} {tableName}");
        sb.AppendLine("(");
        sb.AppendLine(BuildColumnBody(table.Columns, table.PrimaryKey, table.UniqueConstraints, fmt, includeConstraintNames: true));
        sb.AppendLine($") {fmt.Kw("ON")} [PRIMARY]");
        sb.AppendLine("GO");

        // Index'ler (CREATE TABLE'dan sonra)
        foreach (var index in table.Indexes)
        {
            sb.AppendLine();
            sb.Append(IndexScripter.Script(table.Name, index, fmt));
        }

        // Check constraint'ler
        foreach (var check in table.CheckConstraints)
        {
            sb.AppendLine();
            sb.Append(CheckConstraintScripter.Script(table.Name, check, fmt));
        }

        // Foreign key'ler (en sonda)
        foreach (var fk in table.ForeignKeys)
        {
            sb.AppendLine();
            sb.Append(ForeignKeyScripter.Script(table.Name, fk, fmt));
        }

        return sb.ToString();
    }

    // CREATE TABLE'ın iç gövdesini (kolonlar, PK, ayraç boş satırları) üretir.
    // Hizalama: tanımlayıcı | veri tipi | geri kalanı, her sütun en uzun değere göre doldurulur.
    // Boş satır kuralları: (1) PK constraint öncesi; (2) audit kolon bloklarının öncesi/sonrası.
    // Tablolarda ve table type'larda paylaşılır. includeConstraintNames=false ise PK/UNIQUE
    // constraint adı yazılmaz (table type constraint adları sistem-üretimlidir, taşınmaz).
    internal static string BuildColumnBody(
        IReadOnlyList<ColumnInfo> columns, PrimaryKeyInfo? primaryKey,
        IReadOnlyList<UniqueConstraintInfo> uniqueConstraints, ScriptFormat fmt, bool includeConstraintNames)
    {
        // (Id, Type, Suffix) parçalarına böl; computed kolonlarda Type boştur.
        var parts = new List<(string Id, string Type, string Suffix)>();
        foreach (var col in columns)
        {
            string id = SqlIdentifier.Quote(col.Name);

            if (col.IsComputed)
            {
                parts.Add((id, string.Empty, $"{fmt.Kw("AS")} {col.ComputedDefinition}"));
                continue;
            }

            parts.Add((id, SqlTypeFormatter.Format(col.TypeName, col.MaxLength, col.Precision, col.Scale, fmt), BuildColumnSuffix(col, fmt)));
        }

        int idWidth = parts.Count == 0 ? 0 : parts.Max(p => p.Id.Length);
        int typeWidth = parts.Count == 0 ? 0 : parts.Max(p => p.Type.Length);

        // items: hizalanmış kolon satırları + (varsa) PK constraint satırı.
        var items = parts
            .Select(p => $"\t{p.Id.PadRight(idWidth)} {p.Type.PadRight(typeWidth)} {p.Suffix}".TrimEnd())
            .ToList();

        // Constraint bloğu: önce PK, sonra UNIQUE constraint'ler (inline).
        int firstConstraintIndex = items.Count;
        if (primaryKey is { } pk)
        {
            items.Add("\t" + ScriptPrimaryKey(pk, fmt, includeConstraintNames));
        }

        foreach (var uq in uniqueConstraints)
        {
            items.Add("\t" + ScriptUniqueConstraint(uq, fmt, includeConstraintNames));
        }

        bool hasConstraint = items.Count > firstConstraintIndex;

        // Boş satır pozisyonları (item indeksine göre). Kolon indeksleri = item indeksleri,
        // çünkü kolonlar items'ın başında yer alır.
        var blankBefore = new HashSet<int>();
        var blankAfter = new HashSet<int>();
        DetectAuditBlocks(columns, fmt.AuditColumns, blankBefore, blankAfter);
        if (fmt.GroupColumns)
        {
            DetectWordGroups(columns, fmt.AuditColumns, blankBefore, blankAfter);
        }

        if (hasConstraint)
        {
            blankBefore.Add(firstConstraintIndex);
        }

        var outLines = new List<string>();
        void AddBlank()
        {
            if (outLines.Count > 0 && outLines[^1].Length != 0)
            {
                outLines.Add(string.Empty);
            }
        }

        for (int i = 0; i < items.Count; i++)
        {
            if (blankBefore.Contains(i))
            {
                AddBlank();
            }

            string comma = i < items.Count - 1 ? "," : string.Empty;
            outLines.Add(items[i] + comma);

            if (blankAfter.Contains(i) && i < items.Count - 1)
            {
                AddBlank();
            }
        }

        return string.Join("\n", outLines);
    }

    // Ardışık audit kolonu gruplarını (>= 2) bulur ve grubun başından önce / sonundan sonra
    // boş satır işaretler. Grup tablonun en başındaysa öncesine boşluk konmaz.
    private static void DetectAuditBlocks(
        IReadOnlyList<ColumnInfo> columns, IReadOnlySet<string> auditColumns,
        HashSet<int> blankBefore, HashSet<int> blankAfter)
    {
        int i = 0;
        while (i < columns.Count)
        {
            if (!auditColumns.Contains(columns[i].Name))
            {
                i++;
                continue;
            }

            int start = i;
            while (i + 1 < columns.Count && auditColumns.Contains(columns[i + 1].Name))
            {
                i++;
            }

            if (i - start + 1 >= 2)
            {
                if (start > 0)
                {
                    blankBefore.Add(start);
                }

                blankAfter.Add(i);
            }
            i++;
        }
    }

    // Audit olmayan ardışık kolonları, ortak kelime paylaştıkları sürece zincirleyerek gruplar.
    // En az 2 kolonluk grupların öncesine/sonrasına boş satır işaretler. Audit kolonları zinciri kırar
    // (onlar ayrıca DetectAuditBlocks tarafından ele alınır).
    private static void DetectWordGroups(
        IReadOnlyList<ColumnInfo> columns, IReadOnlySet<string> auditColumns,
        HashSet<int> blankBefore, HashSet<int> blankAfter)
    {
        var tokens = columns.Select(c => Tokenize(c.Name)).ToList();

        int i = 0;
        while (i < columns.Count)
        {
            if (auditColumns.Contains(columns[i].Name))
            {
                i++;
                continue;
            }

            int start = i;
            while (i + 1 < columns.Count
                   && !auditColumns.Contains(columns[i + 1].Name)
                   && tokens[i].Overlaps(tokens[i + 1]))
            {
                i++;
            }

            if (i - start + 1 >= 2)
            {
                if (start > 0)
                {
                    blankBefore.Add(start);
                }

                blankAfter.Add(i);
            }
            i++;
        }
    }

    // Kolon adını kelimelerine ayırır: '_' ve camelCase/PascalCase sınırları (büyük/küçük harf duyarsız).
    private static HashSet<string> Tokenize(string name)
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var part in name.Split('_', StringSplitOptions.RemoveEmptyEntries))
        {
            foreach (var word in SplitCamelCase(part))
            {
                set.Add(word);
            }
        }

        return set;
    }

    private static IEnumerable<string> SplitCamelCase(string s)
    {
        int start = 0;
        for (int i = 1; i < s.Length; i++)
        {
            // "UpdatedAt" -> Updated|At ; "XMLData" -> XML|Data ; "PROCESS" -> bütün kalır
            bool boundary = char.IsUpper(s[i])
                && (char.IsLower(s[i - 1]) || (i + 1 < s.Length && char.IsLower(s[i + 1])));
            if (boundary)
            {
                yield return s[start..i];
                start = i;
            }
        }
        if (start < s.Length)
        {
            yield return s[start..];
        }
    }

    // Tipten sonraki kısım: COLLATE, IDENTITY, NULL/NOT NULL, DEFAULT.
    private static string BuildColumnSuffix(ColumnInfo col, ScriptFormat fmt)
    {
        var sb = new StringBuilder();

        // COLLATE yalnızca kolon collation'ı DB varsayılanından farklıysa yazılır
        // (DB collation bilinmiyorsa güvenli tarafta kalıp yazarız).
        if (col.CollationName is not null && IsCharType(col.TypeName)
            && !string.Equals(col.CollationName, fmt.DatabaseCollation, StringComparison.OrdinalIgnoreCase))
        {
            sb.Append($"{fmt.Kw("COLLATE")} {col.CollationName} ");
        }

        if (col.IsIdentity)
        {
            sb.Append($"{fmt.Kw("IDENTITY")}({col.IdentitySeed ?? 1},{col.IdentityIncrement ?? 1}) ");
        }

        sb.Append(col.IsNullable ? fmt.Kw("NULL") : fmt.Kw("NOT NULL"));

        if (col.DefaultDefinition is not null)
        {
            string ctr = col.DefaultConstraintName is not null
                ? $" {fmt.Kw("CONSTRAINT")} {SqlIdentifier.Quote(col.DefaultConstraintName)}"
                : string.Empty;
            sb.Append($"{ctr} {fmt.Kw("DEFAULT")} {col.DefaultDefinition}");
        }

        return sb.ToString();
    }

    private static string ScriptPrimaryKey(PrimaryKeyInfo pk, ScriptFormat fmt, bool includeName)
    {
        string clustered = pk.IsClustered ? fmt.Kw("CLUSTERED") : fmt.Kw("NONCLUSTERED");
        var cols = pk.Columns.Select(c =>
            $"{SqlIdentifier.Quote(c.Column)} {(c.Descending ? fmt.Kw("DESC") : fmt.Kw("ASC"))}");
        string prefix = includeName ? $"{fmt.Kw("CONSTRAINT")} {SqlIdentifier.Quote(pk.Name)} " : string.Empty;
        return $"{prefix}{fmt.Kw("PRIMARY KEY")} {clustered} ({string.Join(", ", cols)})";
    }

    private static string ScriptUniqueConstraint(UniqueConstraintInfo uq, ScriptFormat fmt, bool includeName)
    {
        string clustered = uq.IsClustered ? fmt.Kw("CLUSTERED") : fmt.Kw("NONCLUSTERED");
        var cols = uq.Columns.Select(c =>
            $"{SqlIdentifier.Quote(c.Column)} {(c.Descending ? fmt.Kw("DESC") : fmt.Kw("ASC"))}");
        string prefix = includeName ? $"{fmt.Kw("CONSTRAINT")} {SqlIdentifier.Quote(uq.Name)} " : string.Empty;
        return $"{prefix}{fmt.Kw("UNIQUE")} {clustered} ({string.Join(", ", cols)})";
    }

    private static bool IsCharType(string typeName) =>
        typeName.ToLowerInvariant() is "varchar" or "char" or "nvarchar" or "nchar" or "text" or "ntext";
}
