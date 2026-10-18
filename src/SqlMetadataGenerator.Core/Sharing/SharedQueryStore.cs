using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SqlMetadataGenerator.Sharing;

// A query someone kept so they could send the link to a colleague.
//
// There is no author field. The application has no sign-in, so anything written there would be a
// guess, and a guessed name beside a query is worse than no name at all.
public sealed class SharedQuery
{
    public required string Id { get; init; }
    public required string Alias { get; init; }
    public required string Database { get; init; }
    public required string Sql { get; init; }
    // Optional label, so a list of links is readable later. Absent when nobody typed one.
    public string? Title { get; init; }
    public required DateTime CreatedUtc { get; init; }
}

// Shared queries on disk: one small JSON file per query in a directory beside connections.json.
//
// A DIRECTORY rather than a single queries.json, for three reasons that all showed up when the
// alternative was written out: two people sharing at the same moment would each rewrite the whole
// file and one would lose, deleting a share would mean rewriting every other one, and a single
// corrupt file would take the entire history with it. One file per query has none of those.
//
// This is the first thing the application writes that is its own data rather than the user's
// configuration. It writes nothing to any database being browsed; that promise is unchanged.
public sealed class SharedQueryStore(string directory)
{
    // 64 random bits, rendered URL-safe. NOT sequential: the link is the only thing protecting a
    // query, so countable ids would let anyone walk through a colleague's shares by adding one.
    private const int IdBytes = 8;

    // A query that cannot be run is a query not worth storing; this matches QueryGuard's own cap
    // so that nothing can be saved which the runner would later refuse.
    public const int MaxSqlLength = 20000;
    public const int MaxTitleLength = 120;

    public string Directory { get; } = directory;

    public SharedQuery Save(string alias, string database, string sql, string? title)
    {
        var record = new SharedQuery
        {
            Id = NewId(),
            Alias = alias,
            Database = database,
            Sql = sql,
            Title = string.IsNullOrWhiteSpace(title) ? null : title.Trim(),
            CreatedUtc = DateTime.UtcNow,
        };

        System.IO.Directory.CreateDirectory(Directory);
        string path = PathFor(record.Id);
        // Written beside the target and moved over it, so a crash mid-write cannot leave half a
        // JSON document where a share should be.
        string temp = path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(record, SharedQueryJsonContext.Default.SharedQuery) + Environment.NewLine);
        File.Move(temp, path, overwrite: true);
        return record;
    }

    // Null when there is no such share. A deleted or mistyped link is an ordinary outcome, not an
    // error worth throwing over.
    public SharedQuery? Find(string id)
    {
        if (!IsValidId(id))
        {
            return null;
        }

        string path = PathFor(id);
        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize(File.ReadAllText(path), SharedQueryJsonContext.Default.SharedQuery);
        }
        catch (JsonException)
        {
            // One unreadable file must not look like a server fault to the person who clicked
            // the link; it reads as a share that is no longer there, which is what it is.
            return null;
        }
    }

    // The id reaches here from a URL, so it is checked against the alphabet it was generated from
    // before it is ever joined to a path. Nothing else is accepted, which is also what keeps
    // '..' and separators out.
    public static bool IsValidId(string? id) =>
        !string.IsNullOrEmpty(id) &&
        id.Length <= 32 &&
        id.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_');

    private string PathFor(string id) => Path.Combine(Directory, id + ".json");

    private static string NewId() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(IdBytes))
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
}

[JsonSourceGenerationOptions(
    WriteIndented = true,
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    PropertyNameCaseInsensitive = true,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(SharedQuery))]
internal partial class SharedQueryJsonContext : JsonSerializerContext;
