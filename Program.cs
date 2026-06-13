using Microsoft.Data.SqlClient;
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

    // Tablolar/synonym'ler her zaman tam çekilir; sadece değişen modüllerin tanımı çekilir.
    var collationTask = reader.ReadDatabaseCollationAsync();
    var tablesTask = reader.ReadTablesAsync();
    var synonymsTask = reader.ReadSynonymsAsync();
    var modulesTask = reader.ReadModuleDefinitionsAsync(changed);
    await Task.WhenAll(collationTask, tablesTask, synonymsTask, modulesTask);

    string? dbCollation = await collationTask;
    var tables = await tablesTask;
    var synonyms = await synonymsTask;
    var modules = await modulesTask;

    var fmt = options.ToScriptFormat(dbCollation);
    Console.WriteLine($"Veritabanı collation: {dbCollation ?? "(okunamadı)"}");

    var newSnapshot = new Snapshot();

    // Tablolar
    foreach (var table in tables)
    {
        string file = await writer.WriteAsync("Tables", table.Name.FileBaseName, TableScripter.Script(table, fmt));
        newSnapshot.Objects[table.Name.FileBaseName] = new SnapshotEntry { Category = "Tables", File = file };
    }
    Console.WriteLine($"Tablolar: {tables.Count} script yazıldı.");

    // Değişen modüller (view / stored procedure / function / trigger)
    var changedModifyByKey = changed.ToDictionary(h => h.Name.FileBaseName, h => h.ModifyDate.ToString("o"));
    foreach (var module in modules)
    {
        string key = module.Name.FileBaseName;
        string file = await writer.WriteAsync(module.CategoryFolder, key, ModuleScripter.Script(module.Definition, fmt));
        newSnapshot.Objects[key] = new SnapshotEntry
        {
            Category = module.CategoryFolder,
            File = file,
            ModifyDate = changedModifyByKey[key],
        };
    }

    // Değişmeyen modüller: dosya zaten diskte, eski snapshot kaydını taşı.
    foreach (var h in unchanged)
        if (oldSnapshot.Objects.TryGetValue(h.Name.FileBaseName, out var prev))
            newSnapshot.Objects[h.Name.FileBaseName] = prev;

    foreach (var group in moduleHeaders.GroupBy(m => m.CategoryFolder).OrderBy(g => g.Key))
        Console.WriteLine($"{group.Key}: {group.Count()} nesne ({changed.Count(c => c.CategoryFolder == group.Key)} yeniden çekildi).");

    // Synonyms
    foreach (var synonym in synonyms)
    {
        string file = await writer.WriteAsync("Synonyms", synonym.Name.FileBaseName, SynonymScripter.Script(synonym, fmt));
        newSnapshot.Objects[synonym.Name.FileBaseName] = new SnapshotEntry { Category = "Synonyms", File = file };
    }
    Console.WriteLine($"Synonyms: {synonyms.Count} script yazıldı.");

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
