using System.Text;

namespace SqlMetadataGenerator;

/// <summary>
/// SSMS'teki gibi dizin yapısını oluşturur ve script dosyalarını yazar.
/// Yapı: {outputRoot}/{server}/{database}/{Tables|Views|Synonyms|Programmability}
/// </summary>
public sealed class OutputWriter
{
    /// <summary>SSMS Object Explorer altındaki standart klasör adları.</summary>
    public static readonly string[] CategoryFolders =
        ["Tables", "Views", "Synonyms", "Programmability"];

    public string ServerRoot { get; }
    public string DatabaseRoot { get; }

    // Çakışma çözümü kategori bazında ayrı tutulur (Tables ile Views çakışmaz).
    private readonly Dictionary<string, SafeFileName> _namersByCategory = new();

    public OutputWriter(string outputRoot, string server, string database)
    {
        string serverDir = SafeFileName.MakeSafe(server);
        string dbDir = SafeFileName.MakeSafe(database);

        ServerRoot = Path.Combine(outputRoot, serverDir);
        DatabaseRoot = Path.Combine(ServerRoot, dbDir);

        foreach (var folder in CategoryFolders)
            Directory.CreateDirectory(Path.Combine(DatabaseRoot, folder));
    }

    /// <summary>
    /// Bir script'i ilgili kategori klasörüne "schema.name.sql" olarak yazar.
    /// Geçersiz karakterler temizlenir, çakışmalar kategori içinde benzersizleştirilir.
    /// Yazılan dosya adını (uzantı dâhil) döndürür — snapshot'ta saklamak için.
    /// </summary>
    public async Task<string> WriteAsync(string category, string objectName, string script, CancellationToken ct = default)
    {
        // category "Programmability/Stored Procedures" gibi alt klasör içerebilir;
        // '/' ayraçlarını platform bağımsız şekilde birleştir.
        string[] segments = category.Split('/', StringSplitOptions.RemoveEmptyEntries);
        string dir = Path.Combine([DatabaseRoot, .. segments]);
        Directory.CreateDirectory(dir);

        if (!_namersByCategory.TryGetValue(category, out var namer))
        {
            namer = new SafeFileName();
            _namersByCategory[category] = namer;
        }

        string fileName = namer.Reserve(objectName) + ".sql";
        string path = Path.Combine(dir, fileName);
        await File.WriteAllTextAsync(path, script, new UTF8Encoding(encoderShouldEmitUTF8Identifier: true), ct);
        return fileName;
    }

    /// <summary>Snapshot'taki bir kayda karşılık gelen dosyayı siler (varsa).</summary>
    public void DeleteFile(string category, string fileName)
    {
        string[] segments = category.Split('/', StringSplitOptions.RemoveEmptyEntries);
        string path = Path.Combine([DatabaseRoot, .. segments, fileName]);
        if (File.Exists(path))
            File.Delete(path);
    }
}
