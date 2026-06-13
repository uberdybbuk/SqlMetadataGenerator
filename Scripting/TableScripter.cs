using System.Text;
using SqlMetadataGenerator.Model;

namespace SqlMetadataGenerator.Scripting;

/// <summary>
/// Tablo metadatasından CREATE TABLE T-SQL'i üretir.
/// İlk sürüm: kolonlar (tip, identity, computed, nullability, default) + primary key.
/// (Foreign key'ler, non-clustered index'ler sonraki adımlarda eklenecek.)
/// </summary>
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
        sb.AppendLine(BuildColumnBody(table, fmt));
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

    /// <summary>
    /// CREATE TABLE'ın iç gövdesini (kolonlar, PK, ayraç boş satırları) üretir.
    /// Hizalama: tanımlayıcı | veri tipi | geri kalanı, her sütun en uzun değere göre doldurulur.
    /// Boş satır kuralları: (1) PK constraint öncesi; (2) audit kolon bloklarının öncesi/sonrası.
    /// </summary>
    private static string BuildColumnBody(TableInfo table, ScriptFormat fmt)
    {
        // (Id, Type, Suffix) parçalarına böl; computed kolonlarda Type boştur.
        var parts = new List<(string Id, string Type, string Suffix)>();
        foreach (var col in table.Columns)
        {
            string id = SqlIdentifier.Quote(col.Name);

            if (col.IsComputed)
            {
                parts.Add((id, string.Empty, $"{fmt.Kw("AS")} {col.ComputedDefinition}"));
                continue;
            }

            parts.Add((id, FormatDataType(col, fmt), BuildColumnSuffix(col, fmt)));
        }

        int idWidth = parts.Count == 0 ? 0 : parts.Max(p => p.Id.Length);
        int typeWidth = parts.Count == 0 ? 0 : parts.Max(p => p.Type.Length);

        // items: hizalanmış kolon satırları + (varsa) PK constraint satırı.
        var items = parts
            .Select(p => $"\t{p.Id.PadRight(idWidth)} {p.Type.PadRight(typeWidth)} {p.Suffix}".TrimEnd())
            .ToList();

        // Constraint bloğu: önce PK, sonra UNIQUE constraint'ler (inline).
        int firstConstraintIndex = items.Count;
        if (table.PrimaryKey is { } pk)
            items.Add("\t" + ScriptPrimaryKey(pk, fmt));
        foreach (var uq in table.UniqueConstraints)
            items.Add("\t" + ScriptUniqueConstraint(uq, fmt));
        bool hasConstraint = items.Count > firstConstraintIndex;

        // Boş satır pozisyonları (item indeksine göre). Kolon indeksleri = item indeksleri,
        // çünkü kolonlar items'ın başında yer alır.
        var blankBefore = new HashSet<int>();
        var blankAfter = new HashSet<int>();
        DetectAuditBlocks(table.Columns, fmt.AuditColumns, blankBefore, blankAfter);
        if (hasConstraint)
            blankBefore.Add(firstConstraintIndex);

        var outLines = new List<string>();
        void AddBlank()
        {
            if (outLines.Count > 0 && outLines[^1].Length != 0)
                outLines.Add(string.Empty);
        }

        for (int i = 0; i < items.Count; i++)
        {
            if (blankBefore.Contains(i))
                AddBlank();

            string comma = i < items.Count - 1 ? "," : string.Empty;
            outLines.Add(items[i] + comma);

            if (blankAfter.Contains(i) && i < items.Count - 1)
                AddBlank();
        }

        return string.Join("\n", outLines);
    }

    /// <summary>
    /// Ardışık audit kolonu gruplarını (>= 2) bulur ve grubun başından önce / sonundan sonra
    /// boş satır işaretler. Grup tablonun en başındaysa öncesine boşluk konmaz.
    /// </summary>
    private static void DetectAuditBlocks(
        List<ColumnInfo> columns, IReadOnlySet<string> auditColumns,
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
                i++;

            if (i - start + 1 >= 2)
            {
                if (start > 0)
                    blankBefore.Add(start);
                blankAfter.Add(i);
            }
            i++;
        }
    }

    /// <summary>Tipten sonraki kısım: COLLATE, IDENTITY, NULL/NOT NULL, DEFAULT.</summary>
    private static string BuildColumnSuffix(ColumnInfo col, ScriptFormat fmt)
    {
        var sb = new StringBuilder();

        // COLLATE yalnızca kolon collation'ı DB varsayılanından farklıysa yazılır
        // (DB collation bilinmiyorsa güvenli tarafta kalıp yazarız).
        if (col.CollationName is not null && IsCharType(col.TypeName)
            && !string.Equals(col.CollationName, fmt.DatabaseCollation, StringComparison.OrdinalIgnoreCase))
            sb.Append($"{fmt.Kw("COLLATE")} {col.CollationName} ");

        if (col.IsIdentity)
            sb.Append($"{fmt.Kw("IDENTITY")}({col.IdentitySeed ?? 1},{col.IdentityIncrement ?? 1}) ");

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

    private static string ScriptPrimaryKey(PrimaryKeyInfo pk, ScriptFormat fmt)
    {
        string clustered = pk.IsClustered ? fmt.Kw("CLUSTERED") : fmt.Kw("NONCLUSTERED");
        var cols = pk.Columns.Select(c =>
            $"{SqlIdentifier.Quote(c.Column)} {(c.Descending ? fmt.Kw("DESC") : fmt.Kw("ASC"))}");
        return $"{fmt.Kw("CONSTRAINT")} {SqlIdentifier.Quote(pk.Name)} " +
               $"{fmt.Kw("PRIMARY KEY")} {clustered} ({string.Join(", ", cols)})";
    }

    private static string ScriptUniqueConstraint(UniqueConstraintInfo uq, ScriptFormat fmt)
    {
        string clustered = uq.IsClustered ? fmt.Kw("CLUSTERED") : fmt.Kw("NONCLUSTERED");
        var cols = uq.Columns.Select(c =>
            $"{SqlIdentifier.Quote(c.Column)} {(c.Descending ? fmt.Kw("DESC") : fmt.Kw("ASC"))}");
        return $"{fmt.Kw("CONSTRAINT")} {SqlIdentifier.Quote(uq.Name)} " +
               $"{fmt.Kw("UNIQUE")} {clustered} ({string.Join(", ", cols)})";
    }

    /// <summary>Tip adını uzunluk/precision/scale ile birlikte biçimlendirir.</summary>
    private static string FormatDataType(ColumnInfo col, ScriptFormat fmt)
    {
        string t = col.TypeName.ToLowerInvariant();
        string name = fmt.Kw(t);

        switch (t)
        {
            case "varchar" or "char" or "varbinary" or "binary":
                return $"{name}({LengthToken(col.MaxLength, divideByTwo: false, fmt)})";

            case "nvarchar" or "nchar":
                return $"{name}({LengthToken(col.MaxLength, divideByTwo: true, fmt)})";

            case "decimal" or "numeric":
                return $"{name}({col.Precision}, {col.Scale})";

            // Bu tipler için scale fractional second precision'ı belirtir.
            case "datetime2" or "datetimeoffset" or "time":
                return $"{name}({col.Scale})";

            default:
                return name;
        }
    }

    private static string LengthToken(short maxLength, bool divideByTwo, ScriptFormat fmt)
    {
        if (maxLength == -1)
            return fmt.Kw("max");
        int length = divideByTwo ? maxLength / 2 : maxLength;
        return length.ToString();
    }

    private static bool IsCharType(string typeName) =>
        typeName.ToLowerInvariant() is "varchar" or "char" or "nvarchar" or "nchar" or "text" or "ntext";
}
