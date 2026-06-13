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
    /// Bir script'i {category}/{schema} klasörüne "ad.sql" olarak yazar.
    /// Şema ayrı parametredir (string'e gömülmez), böylece içindeki '/' gibi karakterler de
    /// ekstra dizine bölünmeden güvenle temizlenir. Snapshot için yazılan kaydı döndürür.
    /// </summary>
    public async Task<WrittenFile> WriteAsync(
        string category, string? schema, string objectName, string script, CancellationToken ct = default)
    {
        // Sabit kategori ("Programmability/Stored Procedures") + (varsa) şema → güvenli segmentler.
        var segments = category.Split('/', StringSplitOptions.RemoveEmptyEntries)
            .Select(SafeFileName.MakeSafe)
            .ToList();
        if (schema is not null)
            segments.Add(SafeFileName.MakeSafe(schema));

        string dir = Path.Combine([DatabaseRoot, .. segments]);
        Directory.CreateDirectory(dir);

        // Çakışma çözümü kategori+şema bazında ayrı (farklı şemadaki aynı ad çakışmaz).
        string safeCategory = string.Join('/', segments);
        if (!_namersByCategory.TryGetValue(safeCategory, out var namer))
        {
            namer = new SafeFileName();
            _namersByCategory[safeCategory] = namer;
        }

        string fileName = namer.Reserve(objectName) + ".sql";
        await File.WriteAllTextAsync(Path.Combine(dir, fileName), script, new UTF8Encoding(encoderShouldEmitUTF8Identifier: true), ct);
        return new WrittenFile(safeCategory, fileName);
    }

    /// <summary>
    /// Snapshot'taki bir kayda karşılık gelen dosyayı siler (varsa).
    /// category zaten güvenli segmentlerden oluşur (WrittenFile.Category), bölünmesi güvenlidir.
    /// </summary>
    public void DeleteFile(string category, string fileName)
    {
        string[] segments = category.Split('/', StringSplitOptions.RemoveEmptyEntries);
        string path = Path.Combine([DatabaseRoot, .. segments, fileName]);
        if (File.Exists(path))
            File.Delete(path);
    }
}

/// <summary>Yazılan bir dosyanın snapshot'ta saklanacak konumu (güvenli kategori yolu + dosya adı).</summary>
public readonly record struct WrittenFile(string Category, string File);
