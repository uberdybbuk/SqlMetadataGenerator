using System.Text;

namespace SqlMetadataGenerator;

// Creates the SSMS-style directory structure and writes the script files.
// Layout: {outputRoot}/{server}/{database}/{Tables|Views|Synonyms|Programmability}
public sealed class OutputWriter
{
    // The standard folder names under the SSMS Object Explorer.
    public static readonly string[] CategoryFolders =
        ["Tables", "Views", "Synonyms", "Programmability"];

    public string ServerRoot { get; }
    public string DatabaseRoot { get; }

    // Collision resolution is tracked per category (Tables never collides with Views).
    private readonly Dictionary<string, SafeFileName> _namersByCategory = new();

    public OutputWriter(string outputRoot, string server, string database)
    {
        string serverDir = SafeFileName.MakeSafe(server);
        string dbDir = SafeFileName.MakeSafe(database);

        ServerRoot = Path.Combine(outputRoot, serverDir);
        DatabaseRoot = Path.Combine(ServerRoot, dbDir);

        foreach (var folder in CategoryFolders)
        {
            Directory.CreateDirectory(Path.Combine(DatabaseRoot, folder));
        }
    }

    // Writes a script to {category}/{schema} as "name.sql".
    // The schema is a separate parameter (never baked into the string), so characters like '/' inside it
    // are sanitised safely instead of splitting into an extra directory. Returns the record for the snapshot.
    public async Task<WrittenFile> WriteAsync(
        string category, string? schema, string objectName, string script, CancellationToken ct = default)
    {
        // Fixed category ("Programmability/Stored Procedures") plus the schema, when there is one → safe segments.
        var segments = category.Split('/', StringSplitOptions.RemoveEmptyEntries)
            .Select(SafeFileName.MakeSafe)
            .ToList();
        if (schema is not null)
        {
            segments.Add(SafeFileName.MakeSafe(schema));
        }

        string dir = Path.Combine([DatabaseRoot, .. segments]);
        Directory.CreateDirectory(dir);

        // Collision resolution is per category+schema (the same name in two schemas does not collide).
        string safeCategory = string.Join('/', segments);
        if (!_namersByCategory.TryGetValue(safeCategory, out var namer))
        {
            namer = new SafeFileName();
            _namersByCategory[safeCategory] = namer;
        }

        // Even though the schema is a directory, the file name still reads "{schema}.{name}"; the editor finds it by either.
        string baseName = schema is null ? objectName : $"{schema}.{objectName}";
        string fileName = namer.Reserve(baseName) + ".sql";
        await File.WriteAllTextAsync(Path.Combine(dir, fileName), script, new UTF8Encoding(encoderShouldEmitUTF8Identifier: true), ct);
        return new WrittenFile(safeCategory, fileName);
    }

    // Deletes the file a snapshot record points at, when it still exists.
    // category is already made of safe segments (WrittenFile.Category), so splitting it is safe.
    public void DeleteFile(string category, string fileName)
    {
        string[] segments = category.Split('/', StringSplitOptions.RemoveEmptyEntries);
        string path = Path.Combine([DatabaseRoot, .. segments, fileName]);
        if (File.Exists(path))
        {
            File.Delete(path);
        }
    }
}

// Where a written file lives in the snapshot (the safe category path plus the file name).
public readonly record struct WrittenFile(string Category, string File);
