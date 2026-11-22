using System.Globalization;
using SqlMetadataGenerator.Model;

namespace SqlMetadataGenerator.Scripting;

// Scripts a CHOSEN SET of objects, in an order that runs.
//
// This is the CLI's generate phase with the file writing taken out and a selection put in. The two
// must not drift, so the order below is the CLI's order and the reason for it is the same:
// schemas first because everything sits in one, alias types before table types because a table
// type's column can use one, both before tables, sequences before tables because a column default
// can call NEXT VALUE FOR, tables before modules, and synonyms last because they only name things.
//
// Reading is driven by what was asked for. A selection of three views never pays for the
// seven-query table read; a selection with no modules never asks for a definition. That is the
// whole reason the picker sends names rather than the user pressing "script everything".
public static class ScriptBundle
{
    // The order kinds are emitted in. Also the order the sections appear in a single script.
    private static readonly string[] KindOrder =
    [
        "schemas", "dataTypes", "tableTypes", "sequences", "tables",
        "views", "functions", "procedures", "triggers", "synonyms",
    ];

    // Not in KindOrder: data is not one of the kinds the picker's tree offers, it is a second
    // choice about tables. It is emitted after everything in KindOrder.
    public const string DataKind = "data";

    // The heading written above each section of a single-file script, and the folder each object
    // lands in when the bundle is written as files. Modules carry their own folder (a function's
    // depends on whether it is scalar, inline or table-valued), so they are not in this map.
    private static readonly Dictionary<string, string> Folders = new(StringComparer.OrdinalIgnoreCase)
    {
        ["schemas"] = "Security/Schemas",
        ["dataTypes"] = "Programmability/Types/User-Defined Data Types",
        ["tableTypes"] = "Programmability/Types/User-Defined Table Types",
        ["sequences"] = "Programmability/Sequences",
        ["tables"] = "Tables",
        ["synonyms"] = "Synonyms",
        [DataKind] = "Data",
    };

    // What the PICKER offers. Schemas are in KindOrder because they are emitted first, but they
    // are not on this list: a schema is a dependency of the objects inside it, not a choice. The
    // ones the chosen objects need are worked out and created at the top of the script.
    public static IReadOnlyList<string> Kinds => KindOrder.Where(k => k != "schemas").ToList();

    public sealed record Item(string Kind, string Schema, string Name, string Folder, string Sql);

    // CycleTables: tables whose foreign keys form a cycle among the chosen ones. Non-empty means
    // the data load must be bracketed by NOCHECK/CHECK, because no insert order works.
    public sealed record Result(List<Item> Items, List<string> Missing, List<string> CycleTables);

    public static async Task<Result> BuildAsync(
        MetadataReader reader,
        IReadOnlyCollection<ScriptableObject> wanted,
        ScriptFormat format,
        CancellationToken ct = default)
    {
        return await BuildAsync(reader, wanted, [], null, format, null, ct);
    }

    // The phases BuildAsync reports, by key. A caller adding phases of its own after these (writing
    // the output, packing it) can tell them apart.
    public const string CatalogPhase = "catalog";
    public const string TablesPhase = "tables";
    public const string HeadersPhase = "headers";
    public const string DefinitionsPhase = "definitions";
    public const string WritingPhase = "writing";
    public const string RowsPhase = "rows";

    // data: the tables whose ROWS were asked for, each with its own optional WHERE. Kept separate
    // from the objects list because scripting forty tables' DDL and three tables' rows is the
    // normal case, and one setting covering both would force two passes to get it.
    //
    // connectionString is only needed when data was asked for; that is what the rows are read over.
    //
    // progress: told where the build is. Only the phases this selection needs are added, so a
    // selection of three views never shows a table read it does not make.
    public static async Task<Result> BuildAsync(
        MetadataReader reader,
        IReadOnlyCollection<ScriptableObject> wanted,
        IReadOnlyCollection<DataScripter.Request> data,
        string? connectionString,
        ScriptFormat format,
        ScriptProgress? progress,
        CancellationToken ct = default)
    {
        var byKind = wanted
            .GroupBy(o => o.Kind, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.ToList(), StringComparer.OrdinalIgnoreCase);

        bool Wants(string kind) => byKind.ContainsKey(kind);

        // The table metadata is read when EITHER the DDL or the rows were asked for: writing an
        // INSERT needs the column list, the identity flag and the foreign keys just as much.
        bool wantsTableMetadata = Wants("tables") || data.Count > 0;

        // A set per kind, so an object read from the catalog can be matched back to the request.
        // Names are compared case-insensitively: the request comes from a URL and a UI, and SQL
        // Server's own comparison depends on a collation this code has no business assuming.
        var chosen = byKind.ToDictionary(
            kv => kv.Key,
            kv => new HashSet<string>(kv.Value.Select(Key), StringComparer.OrdinalIgnoreCase),
            StringComparer.OrdinalIgnoreCase);

        bool Chose(string kind, string schema, string name) =>
            chosen.TryGetValue(kind, out var set) && set.Contains($"{schema}.{name}");

        bool wantsModules = KindOrder.Any(k => IsModuleKind(k) && Wants(k));

        // Declared up front, in the order they are shown. The first three run side by side.
        progress?.Add(CatalogPhase, "Reading the catalog");
        if (wantsTableMetadata)
        {
            progress?.Add(TablesPhase, "Reading tables");
        }
        if (wantsModules)
        {
            progress?.Add(HeadersPhase, "Reading module headers");
            progress?.Add(DefinitionsPhase, "Reading module definitions");
        }
        if (wanted.Count > 0)
        {
            progress?.Add(WritingPhase, "Writing definitions");
        }
        if (data.Count > 0)
        {
            progress?.Add(RowsPhase, "Reading rows");
        }

        // A read that counts towards a phase, and the phase finished once all of its reads are.
        async Task<T> Step<T>(string phase, Task<T> task)
        {
            T result = await task;
            progress?.Advance(phase);
            return result;
        }

        async Task FinishWhen(string phase, Func<string?> detail, params Task[] tasks)
        {
            await Task.WhenAll(tasks);
            progress?.Finish(phase, detail());
        }

        // "1 table", "5,612 tables". Every unit here is a plain plural in s.
        static string Count(long n, string unit) =>
            n.ToString("N0", CultureInfo.InvariantCulture) + " " + (n == 1 ? unit.TrimEnd('s') : unit);

        // Only the kinds that were asked for are read. Everything else resolves to an empty list
        // without a round trip.
        // Always read: the preamble needs the owner of every schema the selection turns out to
        // touch, and that is not known until the objects have been resolved. One light query.
        int catalogReads = 1 + new[] { "dataTypes", "tableTypes", "sequences", "synonyms" }.Count(Wants);
        progress?.Start(CatalogPhase, catalogReads, "reads");
        var schemasTask = Step(CatalogPhase, reader.Measure("schemas", reader.ReadSchemasAsync(ct)));
        var dataTypesTask = Wants("dataTypes") ? Step(CatalogPhase, reader.Measure("data types", reader.ReadUserDefinedTypesAsync(ct))) : Empty<UserDefinedTypeInfo>();
        var tableTypesTask = Wants("tableTypes") ? Step(CatalogPhase, reader.Measure("table types", reader.ReadTableTypesAsync(ct))) : Empty<TableTypeInfo>();
        var sequencesTask = Wants("sequences") ? Step(CatalogPhase, reader.Measure("sequences", reader.ReadSequencesAsync(ct))) : Empty<SequenceInfo>();
        var synonymsTask = Wants("synonyms") ? Step(CatalogPhase, reader.Measure("synonyms", reader.ReadSynonymsAsync(ct))) : Empty<SynonymInfo>();
        var catalogDone = FinishWhen(CatalogPhase, () => null, schemasTask, dataTypesTask, tableTypesTask, sequencesTask, synonymsTask);

        // Each of the table read's seven queries is measured on its own, inside, and counted here.
        if (wantsTableMetadata)
        {
            progress?.Start(TablesPhase, MetadataReader.TableReads.Count, "queries");
            progress?.AddSteps(TablesPhase, MetadataReader.TableReads);
        }
        // Only the tables this script needs: the ones whose definition was asked for and the ones
        // whose rows were. Reading every table's metadata to script five of them was most of the
        // wait on a large database.
        var neededTables = (byKind.TryGetValue("tables", out var tableObjects) ? tableObjects : [])
            .Select(o => new ObjectName(o.Schema, o.Name))
            .Concat(data.Select(d => new ObjectName(d.Schema, d.Name)))
            .ToList();
        var tablesTask = wantsTableMetadata
            ? reader.ReadTablesAsync(neededTables, progress?.Counter(TablesPhase), progress?.Stepper(TablesPhase), ct)
            : Empty<TableInfo>();
        var tablesDone = wantsTableMetadata
            ? FinishWhen(TablesPhase, () => Count(tablesTask.Result.Count, "tables"), tablesTask)
            : Task.CompletedTask;

        if (wantsModules)
        {
            progress?.Start(HeadersPhase);
        }
        var headersTask = wantsModules ? reader.Measure("module headers", reader.ReadModuleHeadersAsync(ct)) : Empty<ModuleHeader>();
        var headersDone = wantsModules
            ? FinishWhen(HeadersPhase, () => Count(headersTask.Result.Count, "modules"), headersTask)
            : Task.CompletedTask;

        await Task.WhenAll(catalogDone, tablesDone, headersDone);

        // The definitions are fetched only for the modules that were actually ticked; the headers
        // above are the cheap read that says which object_ids those are.
        var wantedHeaders = (await headersTask)
            .Where(h => Chose(h.Kind, h.Name.Schema, h.Name.Name))
            .ToList();
        if (wantsModules)
        {
            progress?.Start(DefinitionsPhase, MetadataReader.BatchCount(wantedHeaders.Count), "batches");
        }
        var modules = wantedHeaders.Count > 0
            ? await reader.ReadModuleDefinitionsAsync(wantedHeaders, progress?.Counter(DefinitionsPhase), ct)
            : [];
        if (wantsModules)
        {
            progress?.Finish(DefinitionsPhase, Count(modules.Count, "modules"));
        }

        // A module's kind is not on RoutineInfo, so it is carried over from the header that asked
        // for it. Keyed on the identity, because that is what both sides agree on.
        var kindByName = wantedHeaders.ToDictionary(
            h => Key(new ScriptableObject(h.Kind, h.Name.Schema, h.Name.Name)),
            h => h.Kind,
            StringComparer.OrdinalIgnoreCase);

        var items = new List<Item>();
        var found = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var missingData = new List<string>();
        List<string> cycleTables = [];

        void Add(string kind, string schema, string name, string folder, string sql)
        {
            items.Add(new Item(kind, schema, name, folder, sql));
            found.Add($"{kind}\0{schema}.{name}");
            if (kind != DataKind)
            {
                progress?.Advance(WritingPhase);
            }
        }

        if (wanted.Count > 0)
        {
            progress?.Start(WritingPhase, wanted.Count, "objects");
        }

        foreach (string kind in KindOrder)
        {
            if (kind == "schemas" || !Wants(kind))
            {
                continue;
            }

            switch (kind)
            {
                case "dataTypes":
                    foreach (var t in (await dataTypesTask).Where(t => Chose(kind, t.Name.Schema, t.Name.Name)))
                    {
                        Add(kind, t.Name.Schema, t.Name.Name, Folders[kind], UserDefinedTypeScripter.Script(t, format));
                    }
                    break;

                case "tableTypes":
                    foreach (var t in (await tableTypesTask).Where(t => Chose(kind, t.Name.Schema, t.Name.Name)))
                    {
                        Add(kind, t.Name.Schema, t.Name.Name, Folders[kind], TableTypeScripter.Script(t, format));
                    }
                    break;

                case "sequences":
                    foreach (var q in (await sequencesTask).Where(q => Chose(kind, q.Name.Schema, q.Name.Name)))
                    {
                        Add(kind, q.Name.Schema, q.Name.Name, Folders[kind], SequenceScripter.Script(q, format));
                    }
                    break;

                case "tables":
                    foreach (var t in (await tablesTask).Where(t => Chose(kind, t.Name.Schema, t.Name.Name)))
                    {
                        Add(kind, t.Name.Schema, t.Name.Name, Folders[kind], TableScripter.Script(t, format));
                    }
                    break;

                case "synonyms":
                    foreach (var y in (await synonymsTask).Where(y => Chose(kind, y.Name.Schema, y.Name.Name)))
                    {
                        Add(kind, y.Name.Schema, y.Name.Name, Folders[kind], SynonymScripter.Script(y, format));
                    }
                    break;

                default:
                    // views / functions / procedures / triggers, in KindOrder's order.
                    foreach (var m in modules)
                    {
                        string key = $"{m.Name.Schema}.{m.Name.Name}";
                        if (kindByName.TryGetValue(key, out string? moduleKind) &&
                            string.Equals(moduleKind, kind, StringComparison.OrdinalIgnoreCase))
                        {
                            Add(kind, m.Name.Schema, m.Name.Name, m.CategoryFolder, ModuleScripter.Script(m.Definition, format));
                        }
                    }
                    break;
            }
        }

        if (wanted.Count > 0)
        {
            progress?.Finish(WritingPhase, Count(items.Count, "objects"));
        }

        // Rows go after every CREATE in the bundle: an INSERT needs its table to exist.
        if (data.Count > 0)
        {
            var allTables = await tablesTask;
            var chosenTables = new List<TableInfo>();
            var requestByTable = new Dictionary<string, DataScripter.Request>(StringComparer.OrdinalIgnoreCase);

            foreach (var request in data)
            {
                var hit = allTables.FirstOrDefault(t =>
                    string.Equals(t.Name.Schema, request.Schema, StringComparison.OrdinalIgnoreCase) &&
                    string.Equals(t.Name.Name, request.Name, StringComparison.OrdinalIgnoreCase));
                if (hit is null)
                {
                    missingData.Add($"data: {request.Schema}.{request.Name}");
                    continue;
                }
                chosenTables.Add(hit);
                requestByTable[$"{hit.Name.Schema}.{hit.Name.Name}"] = request;
            }

            // Parent tables first. A cycle among the chosen tables means no order works, so the
            // load gets bracketed by NOCHECK/CHECK instead — reported so the caller can say why.
            var (ordered, hasCycle) = DataScripter.SortByDependency(chosenTables);
            progress?.Start(RowsPhase, ordered.Count, "tables");
            long rowsTotal = 0;
            foreach (var table in ordered)
            {
                var ask = requestByTable[$"{table.Name.Schema}.{table.Name.Name}"];
                string tableName = $"{table.Name.Schema}.{table.Name.Name}";
                progress?.Describe(RowsPhase, tableName);
                int rowsHere = 0;
                string sql = await DataScripter.ScriptAsync(
                    connectionString ?? throw new InvalidOperationException("No connection for reading rows."),
                    table,
                    ask.Where,
                    ask.Top,
                    format,
                    ct,
                    rows =>
                    {
                        rowsHere = rows;
                        progress?.Describe(RowsPhase, $"{tableName} · {Count(rows, "rows")}");
                    });
                rowsTotal += rowsHere;
                progress?.Advance(RowsPhase);
                Add(DataKind, table.Name.Schema, table.Name.Name, Folders[DataKind], sql);
            }
            progress?.Finish(RowsPhase, Count(rowsTotal, "rows"));

            if (hasCycle)
            {
                // Generous on purpose: with a cycle present there is no correct order, and turning
                // the checks off for every selected table that HAS a foreign key is obviously safe.
                // The CHECK at the end re-validates all of it.
                cycleTables = ordered
                    .Where(t => t.ForeignKeys.Count > 0)
                    .Select(t => $"{SqlIdentifier.Quote(t.Name.Schema)}.{SqlIdentifier.Quote(t.Name.Name)}")
                    .ToList();
            }
        }

        // Every schema the script turns out to need, created first and guarded. Worked out from
        // the definitions actually emitted rather than asked for.
        //
        // Rows do not count. A table whose rows are in the script either has its CREATE TABLE
        // there too, which brings its schema in, or it has to exist on the target already, and
        // then so does its schema. Counting them put a CREATE SCHEMA at the top of a data-only
        // script, which is meant to carry no definitions at all.
        var needed = items
            .Where(i => i.Kind != DataKind)
            .Select(i => i.Schema)
            .Where(name => !string.Equals(name, "dbo", StringComparison.OrdinalIgnoreCase))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

        if (needed.Count > 0)
        {
            var known = (await schemasTask).ToDictionary(s => s.Name, StringComparer.OrdinalIgnoreCase);
            var preamble = new List<Item>();
            foreach (string name in needed.OrderBy(n => n, StringComparer.OrdinalIgnoreCase))
            {
                // A schema the catalog no longer lists is still created: the objects underneath it
                // are in the script and would fail without it.
                var info = known.GetValueOrDefault(name) ?? new SchemaInfo { Name = name, Owner = "dbo" };
                preamble.Add(new Item("schemas", name, name, Folders["schemas"], GuardedSchema(info, format)));
            }
            items.InsertRange(0, preamble);
        }

        // Anything asked for that the catalog no longer has. The panel's inventory can be minutes
        // old, and a dropped object must be reported rather than silently missing from the output.
        var missing = wanted
            .Where(o => !found.Contains($"{o.Kind}\0{o.Schema}.{o.Name}"))
            .Select(o => $"{o.Kind}: {o.Schema}.{o.Name}")
            .ToList();

        missing.AddRange(missingData);

        return new Result(items, missing, cycleTables);
    }

    // One script, sections in dependency order, each object under a comment naming it. GO between
    // objects: several of these statements have to be the first in their batch.
    public static string ToSingleScript(Result bundle, ScriptFormat fmt)
    {
        var text = new System.Text.StringBuilder();
        string? section = null;
        bool checksOff = false;

        foreach (var item in bundle.Items)
        {
            if (item.Kind != section)
            {
                section = item.Kind;
                text.Append(text.Length > 0 ? "\n" : "").Append("-- ===== ").Append(Title(item.Kind)).Append(" =====\n\n");

                // The chosen tables reference each other in a cycle, so there is no order that
                // loads them. The checks come off for the load and go back on — WITH CHECK, so the
                // constraints are re-validated rather than left merely enabled but untrusted.
                if (item.Kind == DataKind && bundle.CycleTables.Count > 0)
                {
                    text.Append("-- These tables' foreign keys form a cycle: no insert order satisfies them.\n");
                    text.Append("-- The constraints are disabled for the load and re-validated at the end.\n");
                    foreach (string table in bundle.CycleTables)
                    {
                        text.Append(fmt.Kw("ALTER TABLE")).Append(' ').Append(table).Append(' ')
                            .Append(fmt.Kw("NOCHECK CONSTRAINT ALL")).Append(";\n");
                    }
                    text.Append(fmt.Kw("GO")).Append("\n\n");
                    checksOff = true;
                }
            }

            text.Append("-- ").Append(item.Schema).Append('.').Append(item.Name).Append('\n');

            // The scripters end their own output with GO where a statement has to start a batch
            // (CREATE VIEW and friends), and DataScripter ends every INSERT chunk with one. Adding
            // another unconditionally produced the "GO" / "go" pair visible in the output.
            string sql = item.Sql.TrimEnd();
            text.Append(sql).Append('\n');
            if (!EndsWithGo(sql))
            {
                text.Append(fmt.Kw("GO")).Append('\n');
            }
            text.Append('\n');
        }

        if (checksOff)
        {
            text.Append("\n");
            foreach (string table in bundle.CycleTables)
            {
                text.Append(fmt.Kw("ALTER TABLE")).Append(' ').Append(table).Append(' ')
                    .Append(fmt.Kw("WITH CHECK CHECK CONSTRAINT ALL")).Append(";\n");
            }
            text.Append(fmt.Kw("GO")).Append('\n');
        }

        return text.ToString();
    }

    // Tables/Run/TaskInstances.sql — the layout the generator writes to disk, so a bundle
    // downloaded here drops straight into a tree produced by the CLI.
    public static string FilePath(Item item) =>
        string.Equals(item.Kind, "schemas", StringComparison.OrdinalIgnoreCase)
            ? $"{item.Folder}/{Sanitize(item.Name)}.sql"
            : $"{item.Folder}/{Sanitize(item.Schema)}/{Sanitize(item.Name)}.sql";

    public static string Title(string kind) => kind switch
    {
        "schemas" => "Schemas",
        "dataTypes" => "User-defined data types",
        "tableTypes" => "User-defined table types",
        "sequences" => "Sequences",
        "tables" => "Tables",
        "views" => "Views",
        "functions" => "Functions",
        "procedures" => "Stored procedures",
        "triggers" => "Triggers",
        "synonyms" => "Synonyms",
        DataKind => "Data",
        _ => kind,
    };

    // CREATE SCHEMA has to be the first statement in its batch, so the existence check runs it
    // through EXEC. Guarded because this script is aimed at a database that may already have some
    // of these — an unguarded CREATE would stop the whole run on the first one that exists.
    public static string GuardedSchema(SchemaInfo schema, ScriptFormat fmt)
    {
        // SchemaScripter owns what a CREATE SCHEMA looks like; only the GO it appends is dropped,
        // because here the statement lives inside the guard's batch rather than its own.
        string create = string.Join(
            "\n",
            SchemaScripter.Script(schema, fmt)
                .Split('\n')
                .Select(line => line.TrimEnd())
                .Where(line => line.Length > 0 && !line.Trim().Equals("GO", StringComparison.OrdinalIgnoreCase)));

        return $"""
            {fmt.Kw("IF")} {fmt.Kw("SCHEMA_ID")}('{schema.Name.Replace("'", "''")}') {fmt.Kw("IS NULL")}
            {fmt.Kw("BEGIN")}
                {fmt.Kw("EXEC")}('{create.Replace("'", "''")}');
            {fmt.Kw("END")}
            """;
    }

    private static bool EndsWithGo(string sql)
    {
        int lastLine = sql.LastIndexOf('\n');
        return sql[(lastLine + 1)..].Trim().Equals("GO", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsModuleKind(string kind) =>
        kind is "views" or "functions" or "procedures" or "triggers";

    private static string Key(ScriptableObject o) => $"{o.Schema}.{o.Name}";

    private static Task<List<T>> Empty<T>() => Task.FromResult(new List<T>());

    // A SQL Server identifier can hold characters a file name cannot. The generator's own writer
    // does the same thing; a name that needs it is rare and a broken zip is not an option.
    private static string Sanitize(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        return new string(name.Select(c => invalid.Contains(c) ? '_' : c).ToArray());
    }
}
