using Microsoft.Data.SqlClient;
using Spectre.Console;
using SqlMetadataGenerator;
using SqlMetadataGenerator.Model;
using SqlMetadataGenerator.Scripting;

var options = CommandLineOptions.Parse(args, out string? error);
if (options is null)
{
    if (error is not null)
        Console.Error.WriteLine($"Hata: {error}\n");
    Console.WriteLine(CommandLineOptions.UsageText);
    return error is null ? 0 : 1;
}

try
{
    string connectionString = options.BuildConnectionString();
    Console.WriteLine($"Bağlanılıyor: {options.Server} / {options.Database} ...");
    await using (var testConnection = new SqlConnection(connectionString))
        await testConnection.OpenAsync();
    Console.WriteLine("Bağlantı başarılı.");

    var reader = new MetadataReader(connectionString);
    var writer = new OutputWriter(options.OutputRoot, options.Server, options.Database);
    Console.WriteLine($"Çıktı dizini: {Path.GetFullPath(writer.DatabaseRoot)}");

    var oldSnapshot = SnapshotStore.Load(writer.DatabaseRoot);
    Console.WriteLine(options.FullRefresh
        ? "Mod: tam çekme (--full)."
        : oldSnapshot.Objects.Count > 0 ? "Mod: incremental." : "Mod: ilk çalıştırma (tam).");

    // Modül başlıklarını önce çek (hafif), incremental kararını ver.
    var moduleHeaders = await reader.ReadModuleHeadersAsync();
    var changed = new List<ModuleHeader>();
    var unchanged = new List<ModuleHeader>();
    foreach (var h in moduleHeaders)
    {
        bool isUnchanged = !options.FullRefresh
            && oldSnapshot.Objects.TryGetValue(h.Name.FileBaseName, out var prev)
            && prev.ModifyDate == h.ModifyDate.ToString("o");
        (isUnchanged ? unchanged : changed).Add(h);
    }

    // Lambda içinde doldurulup dışında raporlanacak değerler.
    List<SchemaInfo> schemas = [];
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
            // ---- Okuma fazı (paralel) ----
            var tblMetaTask = ctx.AddTask("[green]Tablo metadatası[/]", maxValue: 7);
            int batchCount = MetadataReader.BatchCount(changed.Count);
            var modDefTask = ctx.AddTask("[green]Modül tanımları[/]", maxValue: Math.Max(batchCount, 1));
            if (batchCount == 0)
                modDefTask.Value = modDefTask.MaxValue;

            var tblProgress = new Progress<int>(_ => tblMetaTask.Increment(1));
            var modProgress = new Progress<int>(_ => modDefTask.Increment(1));

            var collationTask = reader.ReadDatabaseCollationAsync();
            var schemasTask = reader.ReadSchemasAsync();
            var synonymsTask = reader.ReadSynonymsAsync();
            var tablesTask = reader.ReadTablesAsync(tblProgress);
            var modulesTask = reader.ReadModuleDefinitionsAsync(changed, modProgress);
            await Task.WhenAll(collationTask, schemasTask, synonymsTask, tablesTask, modulesTask);

            dbCollation = await collationTask;
            schemas = await schemasTask;
            synonyms = await synonymsTask;
            tables = await tablesTask;
            modules = await modulesTask;
            var fmt = options.ToScriptFormat(dbCollation);

            // ---- Yazma fazı ----
            int totalWrite = schemas.Count + tables.Count + modules.Count + synonyms.Count;
            var writeTask = ctx.AddTask("[blue]Script yazılıyor[/]", maxValue: Math.Max(totalWrite, 1));
            if (totalWrite == 0)
                writeTask.Value = writeTask.MaxValue;

            // Şemalar (en başta — diğer nesneler bunlara bağlı). Şema kendisi alt dizinsiz.
            foreach (var schema in schemas)
            {
                var wf = await writer.WriteAsync("Security/Schemas", null, schema.Name, SchemaScripter.Script(schema, fmt));
                newSnapshot.Objects[schema.Name] = new SnapshotEntry { Category = wf.Category, File = wf.File };
                writeTask.Increment(1);
            }

            // Tablolar — Tables/{şema}/{ad}.sql
            foreach (var table in tables)
            {
                var wf = await writer.WriteAsync("Tables", table.Name.Schema, table.Name.Name, TableScripter.Script(table, fmt));
                newSnapshot.Objects[table.Name.FileBaseName] = new SnapshotEntry { Category = wf.Category, File = wf.File };
                writeTask.Increment(1);
            }

            // Değişen modüller (view / stored procedure / function / trigger)
            var changedModifyByKey = changed.ToDictionary(h => h.Name.FileBaseName, h => h.ModifyDate.ToString("o"));
            foreach (var module in modules)
            {
                string key = module.Name.FileBaseName;
                var wf = await writer.WriteAsync(module.CategoryFolder, module.Name.Schema, module.Name.Name, ModuleScripter.Script(module.Definition, fmt));
                newSnapshot.Objects[key] = new SnapshotEntry { Category = wf.Category, File = wf.File, ModifyDate = changedModifyByKey[key] };
                writeTask.Increment(1);
            }

            // Değişmeyen modüller: dosya zaten diskte, eski snapshot kaydını taşı.
            foreach (var h in unchanged)
                if (oldSnapshot.Objects.TryGetValue(h.Name.FileBaseName, out var prev))
                    newSnapshot.Objects[h.Name.FileBaseName] = prev;

            // Synonyms — Synonyms/{şema}/{ad}.sql
            foreach (var synonym in synonyms)
            {
                var wf = await writer.WriteAsync("Synonyms", synonym.Name.Schema, synonym.Name.Name, SynonymScripter.Script(synonym, fmt));
                newSnapshot.Objects[synonym.Name.FileBaseName] = new SnapshotEntry { Category = wf.Category, File = wf.File };
                writeTask.Increment(1);
            }
        });

    // ---- Özet (progress sonrası) ----
    Console.WriteLine($"Veritabanı collation: {dbCollation ?? "(okunamadı)"}");
    Console.WriteLine($"Şemalar: {schemas.Count} | Tablolar: {tables.Count} | Synonyms: {synonyms.Count}");
    foreach (var group in moduleHeaders.GroupBy(m => m.CategoryFolder).OrderBy(g => g.Key))
        Console.WriteLine($"{group.Key}: {group.Count()} nesne ({changed.Count(c => c.CategoryFolder == group.Key)} yeniden çekildi).");

    // Silinen nesneler: eski snapshot'ta olup yenisinde olmayanların dosyalarını sil.
    int deleted = 0;
    foreach (var key in oldSnapshot.Objects.Keys.Except(newSnapshot.Objects.Keys))
    {
        var entry = oldSnapshot.Objects[key];
        writer.DeleteFile(entry.Category, entry.File);
        deleted++;
    }
    if (deleted > 0)
        Console.WriteLine($"Silinen (artık DB'de yok): {deleted} dosya.");

    SnapshotStore.Save(writer.DatabaseRoot, newSnapshot);

    Console.WriteLine("Tamamlandı.");
    return 0;
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
