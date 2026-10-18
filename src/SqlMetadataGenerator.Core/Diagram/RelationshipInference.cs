using SqlMetadataGenerator.Model;

namespace SqlMetadataGenerator.Diagram;

// Works out which tables are related, from COLUMN NAMES rather than foreign keys.
//
// Foreign keys would be ground truth, and they are not usable: in the schema this was measured
// against, 233 tables declare 51 primary keys between them and almost no foreign keys. A diagram
// built on constraints would be empty. The naming convention, on the other hand, holds — 45% of
// the columns ending in "Id" resolve to a table by name alone, and the ones that resolve are
// right: DOC_TYPE_ID -> DOC_TYPE_TBL, DMS_ROLE_ID -> DMS_ROLE_TBL.
//
// Every link here is a GUESS and is labelled with how good a guess it is. Nothing is filtered out
// by confidence on this side: the caller gets all of it and decides what to draw, so turning
// "loose matching" on and off in the UI costs nothing.
public static class RelationshipInference
{
    public enum Confidence
    {
        // The column names a table outright: CustomerId -> Customers.
        High,
        // The column matches a table's key by name, but the name alone does not say so.
        Medium,
        // The same column name appears in both tables and nothing contradicts it.
        Low,
    }

    public sealed record Link(
        ObjectName From,
        string FromColumn,
        ObjectName To,
        string ToColumn,
        Confidence Confidence,
        // Which rule fired, so the UI can explain an edge rather than just drawing it.
        string Rule)
    {
        public bool SelfReference =>
            string.Equals(From.Schema, To.Schema, StringComparison.OrdinalIgnoreCase)
            && string.Equals(From.Name, To.Name, StringComparison.OrdinalIgnoreCase);
    }

    // A column that looks like a reference and resolves to nothing — INITIATOR_ID where no
    // initiator table exists. Reported rather than dropped: "this points somewhere I cannot find"
    // is information, and the UI shows it behind its own toggle.
    public enum Why
    {
        // Nothing in the database is called that.
        NoSuchTable,
        // Two schemas hold a table of that name and neither is the obvious one.
        Ambiguous,
        // The table exists, but the two columns cannot be joined.
        TypeMismatch,
    }

    public sealed record Dangling(ObjectName Table, string Column, Why Why);

    public sealed record Result(List<Link> Links, List<Dangling> Dangling);

    // A column whose name appears in more than this share of the tables is a discriminator, not a
    // reference. TENANT_CODE sits in 76 of 233 tables; matching on it would wire a third of the
    // database into one node.
    // Rule 5 pairs up every table sharing a column name, so a name in N tables costs N(N-1)/2
    // links. Measured on a real schema a 5% cap (11 tables) produced 2,536 low-confidence links
    // against 86 real ones — unreadable, and slow to draw. Three is the most that can be a
    // relationship rather than a convention.
    private const int LooseMaxTables = 3;

    // Names that say nothing about what they point at. Matching on these alone produces an edge
    // between every pair of tables that happens to use the word.
    private static readonly HashSet<string> Generic = new(StringComparer.OrdinalIgnoreCase)
    {
        "id", "code", "name", "status", "type", "date", "no", "key", "value", "description",
        "version", "state", "kind", "title", "text", "note", "order", "sequence", "number",
    };

    public static Result Infer(IReadOnlyList<TableInfo> tables)
    {
        var links = new List<Link>();
        var dangling = new List<Dangling>();

        // Every spelling a table might be referred to by, pointing back at the table. A table is
        // indexed under its normalised name and its singular forms, so both Customers.Id and
        // CustomerId find Customers.
        var byName = new Dictionary<string, List<TableInfo>>(StringComparer.Ordinal);
        foreach (var table in tables)
        {
            foreach (string form in Spellings(table.Name.Name))
            {
                if (!byName.TryGetValue(form, out var list))
                {
                    list = [];
                    byName[form] = list;
                }
                list.Add(table);
            }
        }

        // How many tables use each column name, for the discriminator test below.
        var frequency = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var table in tables)
        {
            foreach (string name in table.Columns.Select(c => c.Name).Distinct(StringComparer.OrdinalIgnoreCase))
            {
                frequency[name] = frequency.GetValueOrDefault(name) + 1;
            }
        }

        int commonAt = LooseMaxTables;

        foreach (var table in tables)
        {
            foreach (var column in table.Columns)
            {
                string n = Normalise(column.Name);

                // A bare "id" is the table's own key, never a reference out of it.
                if (n.Length == 0 || n == "id")
                {
                    AddLooseMatches(table, column, tables, frequency, commonAt, links);
                    continue;
                }

                if (!n.EndsWith("id", StringComparison.Ordinal))
                {
                    AddLooseMatches(table, column, tables, frequency, commonAt, links);
                    continue;
                }

                string stem = n[..^2];

                // ParentId, or Parent<Table>Id where the table is this one: a tree inside one
                // table. The commonest unresolvable name in the measured schema (19 tables) and
                // always a self-reference.
                if (stem == "parent" || (stem.StartsWith("parent", StringComparison.Ordinal)
                        && Spellings(table.Name.Name).Contains(stem["parent".Length..])))
                {
                    string? own = SelfKey(table, column.Name);
                    if (own is not null)
                    {
                        links.Add(new Link(table.Name, column.Name, table.Name, own, Confidence.High, "parent"));
                        continue;
                    }
                }

                var hit = Resolve(stem, table.Name.Schema, byName, out string rule, out bool ambiguous);
                if (hit is null)
                {
                    dangling.Add(new Dangling(table.Name, column.Name,
                        ambiguous ? Why.Ambiguous : Why.NoSuchTable));
                    continue;
                }

                string? target = TargetColumn(hit, column.Name);
                if (target is null || !Compatible(column, hit, target))
                {
                    // It names a table but cannot be joined to it. That is a dangling reference,
                    // not a link — drawing it would assert a join that does not typecheck.
                    dangling.Add(new Dangling(table.Name, column.Name, Why.TypeMismatch));
                    continue;
                }

                links.Add(new Link(table.Name, column.Name, hit.Name, target, Confidence.High, rule));
            }
        }

        AddKeyNameMatches(tables, links);

        return new Result(links, dangling);
    }

    // Rule 4: the column is named exactly like another table's single-column primary key, and that
    // name says something. Medium, because the name does not name the table — only its key.
    private static void AddKeyNameMatches(IReadOnlyList<TableInfo> tables, List<Link> links)
    {
        var byKeyName = new Dictionary<string, List<TableInfo>>(StringComparer.OrdinalIgnoreCase);
        foreach (var table in tables)
        {
            if (table.PrimaryKey is { Columns.Count: 1 })
            {
                string key = table.PrimaryKey.Columns[0].Column;
                if (Generic.Contains(key))
                {
                    continue;
                }
                if (!byKeyName.TryGetValue(key, out var list))
                {
                    list = [];
                    byKeyName[key] = list;
                }
                list.Add(table);
            }
        }

        foreach (var table in tables)
        {
            foreach (var column in table.Columns)
            {
                if (!byKeyName.TryGetValue(column.Name, out var owners) || owners.Count != 1)
                {
                    continue;
                }

                var owner = owners[0];
                if (owner.Name.FileBaseName.Equals(table.Name.FileBaseName, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                string target = owner.PrimaryKey!.Columns[0].Column;
                if (!Compatible(column, owner, target))
                {
                    continue;
                }

                // A rule 1 link already says this better.
                if (links.Any(l => Same(l.From, table.Name) && l.FromColumn.Equals(column.Name, StringComparison.OrdinalIgnoreCase)))
                {
                    continue;
                }

                links.Add(new Link(table.Name, column.Name, owner.Name, target, Confidence.Medium, "key-name"));
            }
        }
    }

    // Rule 5: the same column name in two tables, where the name is distinctive enough to mean
    // something and rare enough not to be a discriminator.
    private static void AddLooseMatches(
        TableInfo table,
        ColumnInfo column,
        IReadOnlyList<TableInfo> tables,
        Dictionary<string, int> frequency,
        int commonAt,
        List<Link> links)
    {
        if (Generic.Contains(column.Name) || Normalise(column.Name).Length < 4)
        {
            return;
        }
        if (frequency.GetValueOrDefault(column.Name) is var seen && (seen < 2 || seen > commonAt))
        {
            return;
        }

        foreach (var other in tables)
        {
            // Emitted once per PAIR, not once per direction: a shared name says the two tables
            // are related, not which one points at the other.
            if (string.CompareOrdinal(table.Name.FileBaseName, other.Name.FileBaseName) >= 0)
            {
                continue;
            }

            var match = other.Columns.FirstOrDefault(c => c.Name.Equals(column.Name, StringComparison.OrdinalIgnoreCase));
            if (match is null || !SameType(column, match))
            {
                continue;
            }

            links.Add(new Link(table.Name, column.Name, other.Name, match.Name, Confidence.Low, "shared-name"));
        }
    }

    // The stem of a column name resolved to a table. An exact spelling wins; failing that the
    // LONGEST table name the stem ends with, so SourceTaskInstanceId finds TaskInstances rather
    // than some shorter table called Instances.
    private static TableInfo? Resolve(
        string stem,
        string fromSchema,
        Dictionary<string, List<TableInfo>> byName,
        out string rule,
        out bool ambiguous)
    {
        rule = "exact";
        ambiguous = false;

        if (byName.TryGetValue(stem, out var exact))
        {
            var pick = Pick(exact, fromSchema, ref rule);
            if (pick is not null)
            {
                return pick;
            }
            ambiguous = true;
            return null;
        }

        TableInfo? best = null;
        int bestLength = 0;
        foreach (var (name, owners) in byName)
        {
            if (name.Length < 4 || name.Length <= bestLength || !stem.EndsWith(name, StringComparison.Ordinal))
            {
                continue;
            }
            string ignored = "suffix";
            var pick = Pick(owners, fromSchema, ref ignored);
            if (pick is not null)
            {
                best = pick;
                bestLength = name.Length;
                rule = ignored;
            }
        }

        if (best is not null)
        {
            return best;
        }

        rule = "suffix";
        return null;
    }

    // One candidate is the answer. Several means the same table name exists in more than one
    // schema — an archive schema mirroring the live one, which is common — and then the one in
    // the REFERRING table's own schema is meant. ARC.SOMETHING.DOC_ID means ARC.DOC, not DMS.DOC.
    private static TableInfo? Pick(List<TableInfo> candidates, string fromSchema, ref string rule)
    {
        if (candidates.Count == 1)
        {
            return candidates[0];
        }

        var local = candidates
            .Where(t => t.Name.Schema.Equals(fromSchema, StringComparison.OrdinalIgnoreCase))
            .ToList();
        if (local.Count == 1)
        {
            rule += "+schema";
            return local[0];
        }

        return null;
    }

    // Which column of the target the reference lands on. Most of these tables have no declared
    // primary key, so the key cannot be the only answer.
    private static string? TargetColumn(TableInfo target, string sourceColumn)
    {
        if (target.PrimaryKey is { Columns.Count: 1 })
        {
            return target.PrimaryKey.Columns[0].Column;
        }

        var same = target.Columns.FirstOrDefault(c => c.Name.Equals(sourceColumn, StringComparison.OrdinalIgnoreCase));
        if (same is not null)
        {
            return same.Name;
        }

        var id = target.Columns.FirstOrDefault(c => Normalise(c.Name) == "id");
        return id?.Name;
    }

    private static string? SelfKey(TableInfo table, string sourceColumn)
    {
        if (table.PrimaryKey is { Columns.Count: 1 })
        {
            return table.PrimaryKey.Columns[0].Column;
        }
        var id = table.Columns.FirstOrDefault(c => Normalise(c.Name) == "id");
        return id?.Name ?? (table.Columns.Any(c => c.Name.Equals(sourceColumn, StringComparison.OrdinalIgnoreCase)) ? sourceColumn : null);
    }

    private static bool Compatible(ColumnInfo column, TableInfo target, string targetColumn)
    {
        var other = target.Columns.FirstOrDefault(c => c.Name.Equals(targetColumn, StringComparison.OrdinalIgnoreCase));
        return other is not null && SameType(column, other);
    }

    // Deliberately strict: the base type must match. int-to-bigint happens in sloppy schemas, but
    // allowing it widens every integer key into a candidate for every other, and the hairball
    // costs more than the few links it would find.
    private static bool SameType(ColumnInfo a, ColumnInfo b) =>
        a.TypeName.Equals(b.TypeName, StringComparison.OrdinalIgnoreCase);

    private static bool Same(ObjectName a, ObjectName b) =>
        a.FileBaseName.Equals(b.FileBaseName, StringComparison.OrdinalIgnoreCase);

    // Lower case, letters and digits only. Separator style is not information: DOC_TYPE_ID,
    // DocTypeId and doctypeid are the same name written three ways.
    internal static string Normalise(string name)
    {
        var text = new System.Text.StringBuilder(name.Length);
        foreach (char c in name)
        {
            if (char.IsLetterOrDigit(c))
            {
                text.Append(char.ToLowerInvariant(c));
            }
        }
        return text.ToString();
    }

    // Every form a table's name might be written in when referred to from elsewhere: as it is,
    // without a TBL suffix, and singular.
    internal static HashSet<string> Spellings(string tableName)
    {
        var forms = new HashSet<string>(StringComparer.Ordinal);
        string n = Normalise(tableName);

        foreach (string suffix in new[] { "tbl", "table" })
        {
            if (n.EndsWith(suffix, StringComparison.Ordinal) && n.Length > suffix.Length + 2)
            {
                n = n[..^suffix.Length];
                break;
            }
        }

        void Add(string form)
        {
            if (form.Length >= 2)
            {
                forms.Add(form);
            }
        }

        Add(n);
        if (n.EndsWith("ies", StringComparison.Ordinal))
        {
            Add(n[..^3] + "y");
        }
        if (n.EndsWith("ses", StringComparison.Ordinal) || n.EndsWith("xes", StringComparison.Ordinal)
            || n.EndsWith("ches", StringComparison.Ordinal) || n.EndsWith("shes", StringComparison.Ordinal))
        {
            Add(n[..^2]);
        }
        if (n.EndsWith("s", StringComparison.Ordinal) && !n.EndsWith("ss", StringComparison.Ordinal))
        {
            Add(n[..^1]);
        }

        return forms;
    }
}
