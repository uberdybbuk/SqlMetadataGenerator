using System.Text.Json;
using System.Text.Json.Serialization;

namespace SqlMetadataGenerator;

// The state an object was written in on the previous run.
// The key is "schema.name" (FileBaseName) — a name is unique within a schema.
public sealed class SnapshotEntry
{
    public required string Category { get; set; }
    public required string File { get; set; }
    // modify_date ("o" format) for modules; null for tables and synonyms (they are always re-read).
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ModifyDate { get; set; }
}

// The manifest describing the previous run's output. Used for the incremental comparison
// and to detect dropped objects.
public sealed class Snapshot
{
    public Dictionary<string, SnapshotEntry> Objects { get; set; } = new();
}

public static class SnapshotStore
{
    private const string FileName = "_snapshot.json";

    public static string PathFor(string databaseRoot) => Path.Combine(databaseRoot, FileName);

    // Loads the snapshot; returns an empty one when it is missing or corrupt.
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
            // Ignore a corrupt snapshot; behave like a full pull.
            return new Snapshot();
        }
    }

    public static void Save(string databaseRoot, Snapshot snapshot)
    {
        Directory.CreateDirectory(databaseRoot);
        File.WriteAllText(PathFor(databaseRoot), JsonSerializer.Serialize(snapshot, SnapshotJsonContext.Default.Snapshot));
    }
}

// Compile-time (source-generated) serialisation instead of reflection: AOT/trimming safe, and faster.
[JsonSourceGenerationOptions(WriteIndented = true)]
[JsonSerializable(typeof(Snapshot))]
internal partial class SnapshotJsonContext : JsonSerializerContext;
