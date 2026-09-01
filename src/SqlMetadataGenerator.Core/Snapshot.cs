using System.Text.Json;
using System.Text.Json.Serialization;

namespace SqlMetadataGenerator;

// Bir nesnenin önceki çalıştırmada yazılan durumunu temsil eder.
// Anahtar olarak "schema.ad" (FileBaseName) kullanılır — bir şemada isim benzersizdir.
public sealed class SnapshotEntry
{
    public required string Category { get; set; }
    public required string File { get; set; }
    // Modüllerde modify_date ("o" formatı); tablo/synonym'de null (her zaman yeniden çekilir).
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ModifyDate { get; set; }
}

// Önceki çalıştırmanın çıktısını tanımlayan manifest. Incremental karşılaştırma ve
// silinen nesnelerin tespiti için kullanılır.
public sealed class Snapshot
{
    public Dictionary<string, SnapshotEntry> Objects { get; set; } = new();
}

public static class SnapshotStore
{
    private const string FileName = "_snapshot.json";

    public static string PathFor(string databaseRoot) => Path.Combine(databaseRoot, FileName);

    // Snapshot'ı yükler; yoksa veya bozuksa boş bir snapshot döner.
    public static Snapshot Load(string databaseRoot)
    {
        string path = PathFor(databaseRoot);
        if (!File.Exists(path))
        {
            return new Snapshot();
        }

        try
        {
            string json = File.ReadAllText(path);
            return JsonSerializer.Deserialize(json, SnapshotJsonContext.Default.Snapshot) ?? new Snapshot();
        }
        catch (JsonException)
        {
            // Bozuk snapshot'ı yok say; tam çekme gibi davran.
            return new Snapshot();
        }
    }

    public static void Save(string databaseRoot, Snapshot snapshot)
    {
        Directory.CreateDirectory(databaseRoot);
        File.WriteAllText(PathFor(databaseRoot), JsonSerializer.Serialize(snapshot, SnapshotJsonContext.Default.Snapshot));
    }
}

// Reflection yerine derleme zamanı (source-generated) serileştirme: AOT/trimming güvenli, daha hızlı.
[JsonSourceGenerationOptions(WriteIndented = true)]
[JsonSerializable(typeof(Snapshot))]
internal partial class SnapshotJsonContext : JsonSerializerContext;
