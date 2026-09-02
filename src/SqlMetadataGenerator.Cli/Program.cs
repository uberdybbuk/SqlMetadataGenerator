using Microsoft.Data.SqlClient;
using Spectre.Console;
using SqlMetadataGenerator.Model;
using SqlMetadataGenerator.Scripting;

namespace SqlMetadataGenerator;

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        var options = CommandLineOptions.Parse(args, out string? error);
        if (options is null)
        {
            if (error is not null)
            {
                Console.Error.WriteLine($"Hata: {error}\n");
            }

            Console.WriteLine(CommandLineOptions.UsageText);
            return error is null ? 0 : 1;
        }

        try
        {
            string connectionString = options.BuildConnectionString();
            Console.WriteLine($"Bağlanılıyor: {options.Server} / {options.Database} ...");
            await using (var testConnection = new SqlConnection(connectionString))
            {
                await testConnection.OpenAsync();
            }

            Console.WriteLine("Bağlantı başarılı.");

            return options.Deploy
                ? await RunDeployAsync(options, connectionString)
                : await RunGenerateAsync(options, connectionString);
        }
        catch (SqlException ex)
        {
            Console.Error.WriteLine($"SQL hatası: {ex.Message}");
            return 2;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Beklenmeyen hata: {ex.Message}");
            return 3;
        }
    }

    // Applies the source files to the target database with a multi-pass retry.
    private static async Task<int> RunDeployAsync(CommandLineOptions options, string connectionString)
    {
        string sourceRoot = options.SourceDir!;
        if (!Directory.Exists(sourceRoot))
        {
            Console.Error.WriteLine($"Kaynak dizin bulunamadı: {sourceRoot}");
            return 1;
        }
        Console.WriteLine($"Deploy kaynağı: {Path.GetFullPath(sourceRoot)}");

        var deployer = new SqlScriptDeployer(connectionString);
        SqlScriptDeployer.DeployReport? report = null;
        await AnsiConsole.Progress()
            .AutoClear(false)
            .Columns(new SpinnerColumn(), new TaskDescriptionColumn(), new ProgressBarColumn(), new PercentageColumn(), new RemainingTimeColumn())
            .StartAsync(async ctx =>
            {
                var task = ctx.AddTask("[blue]Deploy[/]", maxValue: 1);
                report = await deployer.DeployAsync(sourceRoot, (done, total, round) =>
                {
                    task.MaxValue = Math.Max(total, 1);
                    task.Value = done;
                    task.Description = $"[blue]Deploy (tur {round})[/]";
                });
            });

        Console.WriteLine($"Toplam batch: {report!.Total} | Başarılı: {report.Succeeded} | Tur: {report.Rounds}");
        if (report.Failed.Count > 0)
        {
            Console.Error.WriteLine($"Çözülemeyen {report.Failed.Count} batch:");
            foreach (var b in report.Failed.Take(20))
            {
                Console.Error.WriteLine($"  {Path.GetFileName(b.FilePath)}: {b.LastError}");
            }

            if (report.Failed.Count > 20)
            {
                Console.Error.WriteLine($"  ... ve {report.Failed.Count - 20} tane daha.");
            }

            return 4;
        }
        Console.WriteLine("Deploy tamamlandı.");
        return 0;
    }

    // Reads the database metadata (incrementally) and generates the script files.
    private static async Task<int> RunGenerateAsync(CommandLineOptions options, string connectionString)
    {
        var reader = new MetadataReader(connectionString);
        var writer = new OutputWriter(options.OutputRoot, options.Server, options.Database);
        Console.WriteLine($"Çıktı dizini: {Path.GetFullPath(writer.DatabaseRoot)}");

        var oldSnapshot = SnapshotStore.Load(writer.DatabaseRoot);
        Console.WriteLine(options.FullRefresh
            ? "Mod: tam çekme (--full)."
            : oldSnapshot.Objects.Count > 0 ? "Mod: incremental." : "Mod: ilk çalıştırma (tam).");

        var filter = options.Filter;

        // Fetch the module headers first (they are light), apply the filter, then decide on incremental.
        var allHeaders = filter.HasAnyModuleType ? await reader.ReadModuleHeadersAsync() : [];
        var moduleHeaders = allHeaders
            .Where(h => filter.IncludesType(h.Kind) && filter.IncludesObject(h.Name.Schema, h.Name.Name))
            .ToList();
        var changed = new List<ModuleHeader>();
        var unchanged = new List<ModuleHeader>();
        foreach (var h in moduleHeaders)
        {
            bool isUnchanged = !options.FullRefresh
                && oldSnapshot.Objects.TryGetValue(h.Name.FileBaseName, out var prev)
                && prev.ModifyDate == h.ModifyDate.ToString("o");
            (isUnchanged ? unchanged : changed).Add(h);
        }

        // Values filled in inside the progress lambda and reported outside it.
        List<SchemaInfo> schemas = [];
        List<UserDefinedTypeInfo> userTypes = [];
        List<TableTypeInfo> tableTypes = [];
        List<SequenceInfo> sequences = [];
        List<TableInfo> tables = [];
        List<RoutineInfo> modules = [];
        List<SynonymInfo> synonyms = [];
        string? dbCollation = null;
        var newSnapshot = new Snapshot();

        await AnsiConsole.Progress()
            .AutoClear(false)
            .Columns(
                new SpinnerColumn(),
                new TaskDescriptionColumn(),
                new ProgressBarColumn(),
                new PercentageColumn(),
                new RemainingTimeColumn())
            .StartAsync(async ctx =>
            {
                // ---- Read phase (parallel) ----
                var tblMetaTask = ctx.AddTask("[green]Tablo metadatası[/]", maxValue: 7);
                if (!filter.IncludesType("tables"))
                {
                    tblMetaTask.Value = tblMetaTask.MaxValue;
                }

                int batchCount = MetadataReader.BatchCount(changed.Count);
                var modDefTask = ctx.AddTask("[green]Modül tanımları[/]", maxValue: Math.Max(batchCount, 1));
                if (batchCount == 0)
                {
                    modDefTask.Value = modDefTask.MaxValue;
                }

                var tblProgress = new Progress<int>(_ => tblMetaTask.Increment(1));
                var modProgress = new Progress<int>(_ => modDefTask.Increment(1));

                // With a type-level exclusion the matching query never runs at all.
                var collationTask = reader.ReadDatabaseCollationAsync();
                var schemasTask = filter.IncludesType("schemas") ? reader.ReadSchemasAsync() : Task.FromResult(new List<SchemaInfo>());
                var userTypesTask = filter.IncludesType("types") ? reader.ReadUserDefinedTypesAsync() : Task.FromResult(new List<UserDefinedTypeInfo>());
                var tableTypesTask = filter.IncludesType("types") ? reader.ReadTableTypesAsync() : Task.FromResult(new List<TableTypeInfo>());
                var sequencesTask = filter.IncludesType("sequences") ? reader.ReadSequencesAsync() : Task.FromResult(new List<SequenceInfo>());
                var synonymsTask = filter.IncludesType("synonyms") ? reader.ReadSynonymsAsync() : Task.FromResult(new List<SynonymInfo>());
                var tablesTask = filter.IncludesType("tables") ? reader.ReadTablesAsync(tblProgress) : Task.FromResult(new List<TableInfo>());
                var modulesTask = reader.ReadModuleDefinitionsAsync(changed, modProgress);
                await Task.WhenAll(collationTask, schemasTask, userTypesTask, tableTypesTask, sequencesTask, synonymsTask, tablesTask, modulesTask);

                dbCollation = await collationTask;
                // Apply the schema- and name-level exclusions.
                schemas = (await schemasTask).Where(s => filter.IncludesObject(s.Name, s.Name)).ToList();
                userTypes = (await userTypesTask).Where(t => filter.IncludesObject(t.Name.Schema, t.Name.Name)).ToList();
                tableTypes = (await tableTypesTask).Where(t => filter.IncludesObject(t.Name.Schema, t.Name.Name)).ToList();
                sequences = (await sequencesTask).Where(s => filter.IncludesObject(s.Name.Schema, s.Name.Name)).ToList();
                synonyms = (await synonymsTask).Where(s => filter.IncludesObject(s.Name.Schema, s.Name.Name)).ToList();
                tables = (await tablesTask).Where(t => filter.IncludesObject(t.Name.Schema, t.Name.Name)).ToList();
                modules = await modulesTask;
                var fmt = options.ToScriptFormat(dbCollation);

                // ---- Write phase ----
                int totalWrite = schemas.Count + userTypes.Count + tableTypes.Count + sequences.Count + tables.Count + modules.Count + synonyms.Count;
                var writeTask = ctx.AddTask("[blue]Script yazılıyor[/]", maxValue: Math.Max(totalWrite, 1));
                if (totalWrite == 0)
                {
                    writeTask.Value = writeTask.MaxValue;
                }

                // Schemas (first — everything else depends on them). A schema itself gets no sub-directory.
                foreach (var schema in schemas)
                {
                    var wf = await writer.WriteAsync("Security/Schemas", null, schema.Name, SchemaScripter.Script(schema, fmt));
                    newSnapshot.Objects[schema.Name] = new SnapshotEntry { Category = wf.Category, File = wf.File };
                    writeTask.Increment(1);
                }

                // Alias types (after schemas, before tables — columns can depend on them).
                foreach (var userType in userTypes)
                {
                    var wf = await writer.WriteAsync("Programmability/Types/User-Defined Data Types", userType.Name.Schema, userType.Name.Name, UserDefinedTypeScripter.Script(userType, fmt));
                    newSnapshot.Objects[userType.Name.FileBaseName] = new SnapshotEntry { Category = wf.Category, File = wf.File };
                    writeTask.Increment(1);
                }

                // Table types (after alias types — their columns can use an alias type).
                foreach (var tableType in tableTypes)
                {
                    var wf = await writer.WriteAsync("Programmability/Types/User-Defined Table Types", tableType.Name.Schema, tableType.Name.Name, TableTypeScripter.Script(tableType, fmt));
                    newSnapshot.Objects[tableType.Name.FileBaseName] = new SnapshotEntry { Category = wf.Category, File = wf.File };
                    writeTask.Increment(1);
                }

                // Sequences (after schemas, before tables — tables can depend on them).
                foreach (var sequence in sequences)
                {
                    var wf = await writer.WriteAsync("Programmability/Sequences", sequence.Name.Schema, sequence.Name.Name, SequenceScripter.Script(sequence, fmt));
                    newSnapshot.Objects[sequence.Name.FileBaseName] = new SnapshotEntry { Category = wf.Category, File = wf.File };
                    writeTask.Increment(1);
                }

                // Tables — Tables/{schema}/{name}.sql
                foreach (var table in tables)
                {
                    var wf = await writer.WriteAsync("Tables", table.Name.Schema, table.Name.Name, TableScripter.Script(table, fmt));
                    newSnapshot.Objects[table.Name.FileBaseName] = new SnapshotEntry { Category = wf.Category, File = wf.File };
                    writeTask.Increment(1);
                }

                // Changed modules (view / stored procedure / function / trigger)
                var changedModifyByKey = changed.ToDictionary(h => h.Name.FileBaseName, h => h.ModifyDate.ToString("o"));
                foreach (var module in modules)
                {
                    string key = module.Name.FileBaseName;
                    var wf = await writer.WriteAsync(module.CategoryFolder, module.Name.Schema, module.Name.Name, ModuleScripter.Script(module.Definition, fmt));
                    newSnapshot.Objects[key] = new SnapshotEntry { Category = wf.Category, File = wf.File, ModifyDate = changedModifyByKey[key] };
                    writeTask.Increment(1);
                }

                // Unchanged modules: the file is already on disk, so carry the old snapshot record over.
                foreach (var h in unchanged)
                {
                    if (oldSnapshot.Objects.TryGetValue(h.Name.FileBaseName, out var prev))
                    {
                        newSnapshot.Objects[h.Name.FileBaseName] = prev;
                    }
                }

                // Synonyms — Synonyms/{schema}/{name}.sql
                foreach (var synonym in synonyms)
                {
                    var wf = await writer.WriteAsync("Synonyms", synonym.Name.Schema, synonym.Name.Name, SynonymScripter.Script(synonym, fmt));
                    newSnapshot.Objects[synonym.Name.FileBaseName] = new SnapshotEntry { Category = wf.Category, File = wf.File };
                    writeTask.Increment(1);
                }
            });

        // ---- Summary (after the progress display) ----
        Console.WriteLine($"Veritabanı collation: {dbCollation ?? "(okunamadı)"}");
        Console.WriteLine($"Şemalar: {schemas.Count} | Tipler: {userTypes.Count} | Table type: {tableTypes.Count} | Sequence: {sequences.Count} | Tablolar: {tables.Count} | Synonyms: {synonyms.Count}");
        foreach (var group in moduleHeaders.GroupBy(m => m.CategoryFolder).OrderBy(g => g.Key))
        {
            Console.WriteLine($"{group.Key}: {group.Count()} nesne ({changed.Count(c => c.CategoryFolder == group.Key)} yeniden çekildi).");
        }

        // Dropped objects: delete the files that were in the old snapshot but not in the new one.
        int deleted = 0;
        foreach (var key in oldSnapshot.Objects.Keys.Except(newSnapshot.Objects.Keys))
        {
            var entry = oldSnapshot.Objects[key];
            writer.DeleteFile(entry.Category, entry.File);
            deleted++;
        }
        if (deleted > 0)
        {
            Console.WriteLine($"Silinen (artık DB'de yok): {deleted} dosya.");
        }

        SnapshotStore.Save(writer.DatabaseRoot, newSnapshot);

        Console.WriteLine("Tamamlandı.");
        return 0;
    }
}
