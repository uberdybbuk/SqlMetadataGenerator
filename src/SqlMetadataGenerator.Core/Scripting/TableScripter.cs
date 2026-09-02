using System.Text;
using SqlMetadataGenerator.Model;

namespace SqlMetadataGenerator.Scripting;

// Emits CREATE TABLE T-SQL from table metadata.
// First cut: columns (type, identity, computed, nullability, default) plus the primary key.
// (Foreign keys and non-clustered indexes arrive in later steps.)
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

        // Indexes (after CREATE TABLE)
        foreach (var index in table.Indexes)
        {
            sb.AppendLine();
            sb.Append(IndexScripter.Script(table.Name, index, fmt));
        }

        // Check constraints
        foreach (var check in table.CheckConstraints)
        {
            sb.AppendLine();
            sb.Append(CheckConstraintScripter.Script(table.Name, check, fmt));
        }

        // Foreign keys (last)
        foreach (var fk in table.ForeignKeys)
        {
            sb.AppendLine();
            sb.Append(ForeignKeyScripter.Script(table.Name, fk, fmt));
        }

        return sb.ToString();
    }

    // Builds the inner body of CREATE TABLE (columns, primary key, separating blank lines).
    // Alignment: identifier | data type | the rest, each column padded to its longest value.
    // Blank-line rules: (1) before the PK constraint; (2) around audit column blocks.
    // Shared by tables and table types. With includeConstraintNames=false the PK/UNIQUE
    // constraint name is omitted (table type constraint names are system-generated and do not travel).
    internal static string BuildColumnBody(
        IReadOnlyList<ColumnInfo> columns, PrimaryKeyInfo? primaryKey,
        IReadOnlyList<UniqueConstraintInfo> uniqueConstraints, ScriptFormat fmt, bool includeConstraintNames)
    {
        // Split into (Id, Type, Suffix); Type is empty for computed columns.
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

        // items: the aligned column lines plus the PK constraint line, when there is one.
        var items = parts
            .Select(p => $"\t{p.Id.PadRight(idWidth)} {p.Type.PadRight(typeWidth)} {p.Suffix}".TrimEnd())
            .ToList();

        // Constraint block: the primary key first, then UNIQUE constraints (inline).
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

        // Blank-line positions (by item index). Column indexes equal item indexes,
        // because the columns come first in items.
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

    // Finds consecutive runs (>= 2) of audit columns and marks a blank line before the first
    // and after the last. A run at the very top of the table gets no leading blank line.
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

    // Chains consecutive non-audit columns into groups for as long as they share a word.
    // Groups of at least 2 columns get a blank line before and after. Audit columns break the chain
    // (DetectAuditBlocks handles those separately).
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

    // Splits a column name into words at '_' and camelCase/PascalCase boundaries (case-insensitive).
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
            // "UpdatedAt" -> Updated|At ; "XMLData" -> XML|Data ; "PROCESS" -> stays whole
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

    // The part after the type: COLLATE, IDENTITY, NULL/NOT NULL, DEFAULT.
    private static string BuildColumnSuffix(ColumnInfo col, ScriptFormat fmt)
    {
        var sb = new StringBuilder();

        // COLLATE is written only when the column collation differs from the database default
        // (when the database collation is unknown we write it, to stay on the safe side).
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
