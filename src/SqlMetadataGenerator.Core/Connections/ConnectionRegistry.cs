using System.Text.Json;
using Microsoft.Data.SqlClient;

namespace SqlMetadataGenerator.Connections;

// Reads connections.json and resolves an alias to a connection string.
// The alias is forced to the slug rules because it is a URL segment; that avoids both the
// encoding hassle and the fragility that ',' and '\' in real server names would cause.
//
// The registry is also the one writer of the file: the connection screen adds, edits and removes
// entries through it, and every change is written to disk before it becomes visible, so what the
// UI shows and what the next start will load never disagree.
public sealed class ConnectionRegistry
{
    private readonly object _gate = new();
    // Kept as a list, not only a dictionary: the file order is the order the cards are shown in,
    // and a save must not shuffle a hand-edited file.
    private List<ConnectionEntry> _entries;

    private ConnectionRegistry(string filePath, List<ConnectionEntry> entries)
    {
        FilePath = filePath;
        _entries = entries;
    }

    // Where changes are written. Also where a missing file will be created on the first save.
    public string FilePath { get; }

    public IReadOnlyList<ConnectionEntry> All
    {
        get
        {
            lock (_gate)
            {
                return _entries.ToArray();
            }
        }
    }

    // Returns an empty registry when the file is missing (the app still starts, only the connection list is empty).
    // Broken JSON or an invalid alias is never swallowed: it throws an explicit error.
    public static ConnectionRegistry Load(string path)
    {
        if (!File.Exists(path))
        {
            return new ConnectionRegistry(path, []);
        }

        ConnectionFile? file;
        try
        {
            file = JsonSerializer.Deserialize(File.ReadAllText(path), ConnectionJsonContext.Default.ConnectionFile);
        }
        catch (JsonException ex)
        {
            throw new InvalidOperationException($"Could not read '{path}': {ex.Message}", ex);
        }

        var entries = new List<ConnectionEntry>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in file?.Connections ?? [])
        {
            if (!IsValidAlias(entry.Alias))
            {
                throw new InvalidOperationException(
                    $"Invalid alias '{entry.Alias}'. Use only letters, digits, '-' and '_', starting with a letter or digit.");
            }

            if (!seen.Add(entry.Alias))
            {
                throw new InvalidOperationException($"Alias defined more than once: '{entry.Alias}'.");
            }

            entries.Add(entry);
        }

        return new ConnectionRegistry(path, entries);
    }

    public ConnectionEntry? Find(string alias)
    {
        lock (_gate)
        {
            return _entries.Find(e => e.Alias.Equals(alias, StringComparison.OrdinalIgnoreCase));
        }
    }

    // Validation errors come back as InvalidOperationException, the same type Load uses, so the
    // endpoints can turn both into a 400 with the message as it is.
    public void Add(ConnectionEntry entry)
    {
        Validate(entry);
        lock (_gate)
        {
            if (IndexOf(entry.Alias) >= 0)
            {
                throw new InvalidOperationException($"A connection named '{entry.Alias}' already exists.");
            }

            Commit([.. _entries, entry]);
        }
    }

    // The alias is the key and cannot change here: it is a URL segment, and renaming it would
    // break every bookmark into that server. Returns false when there is no such connection.
    public bool Update(string alias, ConnectionEntry entry)
    {
        if (!entry.Alias.Equals(alias, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("The alias of an existing connection cannot be changed.");
        }

        Validate(entry);
        lock (_gate)
        {
            int index = IndexOf(alias);
            if (index < 0)
            {
                return false;
            }

            var next = new List<ConnectionEntry>(_entries);
            next[index] = entry;
            Commit(next);
            return true;
        }
    }

    public bool Remove(string alias)
    {
        lock (_gate)
        {
            int index = IndexOf(alias);
            if (index < 0)
            {
                return false;
            }

            var next = new List<ConnectionEntry>(_entries);
            next.RemoveAt(index);
            Commit(next);
            return true;
        }
    }

    public static void Validate(ConnectionEntry entry)
    {
        if (!IsValidAlias(entry.Alias))
        {
            throw new InvalidOperationException(
                "The alias may contain only letters, digits, '-' and '_', and must start with a letter or digit.");
        }

        if (string.IsNullOrWhiteSpace(entry.Server))
        {
            throw new InvalidOperationException("The server is required.");
        }

        if (!entry.IsIntegrated && !entry.Auth.Equals("sql", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"Unknown authentication '{entry.Auth}'. Use 'sql' or 'integrated'.");
        }

        if (!entry.IsIntegrated && string.IsNullOrWhiteSpace(entry.User))
        {
            throw new InvalidOperationException("SQL Server authentication needs a user name.");
        }
    }

    // Builds the connection string. When database is null, server-level queries use 'master'.
    // Under SQL auth a stored password wins; otherwise it comes from the environment, and without
    // it the error names the variable that was expected.
    public static string BuildConnectionString(ConnectionEntry entry, string? database)
    {
        var builder = new SqlConnectionStringBuilder
        {
            DataSource = entry.Server,
            InitialCatalog = string.IsNullOrWhiteSpace(database) ? "master" : database,
            TrustServerCertificate = entry.TrustServerCertificate,
            Encrypt = entry.Encrypt,
            ApplicationName = "SqlMetadataGenerator.Web",
        };

        if (entry.IsIntegrated)
        {
            builder.IntegratedSecurity = true;
            return builder.ConnectionString;
        }

        string? password = entry.HasStoredPassword
            ? entry.Password
            : Environment.GetEnvironmentVariable(entry.ResolvedPasswordEnv);
        if (string.IsNullOrEmpty(password))
        {
            throw new InvalidOperationException(
                $"No password for '{entry.Alias}'. Enter one on the connection screen or set the '{entry.ResolvedPasswordEnv}' environment variable.");
        }

        builder.UserID = entry.User ?? string.Empty;
        builder.Password = password;
        return builder.ConnectionString;
    }

    // Alias rule: starts with an ASCII letter or digit, then ASCII letters, digits, '-' or '_'.
    // Unicode letters (e.g. 'ş') are excluded on purpose: they need URL encoding and cannot be typed by hand.
    internal static bool IsValidAlias(string? alias)
    {
        if (string.IsNullOrEmpty(alias) || !IsAsciiLetterOrDigit(alias[0]))
        {
            return false;
        }

        foreach (char c in alias)
        {
            if (!IsAsciiLetterOrDigit(c) && c is not ('-' or '_'))
            {
                return false;
            }
        }
        return true;
    }

    private static bool IsAsciiLetterOrDigit(char c) => char.IsAsciiLetterOrDigit(c);

    private int IndexOf(string alias) =>
        _entries.FindIndex(e => e.Alias.Equals(alias, StringComparison.OrdinalIgnoreCase));

    // Disk first, memory second: when the write fails the registry keeps the old list, so the UI
    // never shows a connection that the next start would not load.
    // The file is written beside the target and moved over it, so a crash mid-write leaves the
    // old file intact rather than half a JSON document.
    private void Commit(List<ConnectionEntry> next)
    {
        string json = JsonSerializer.Serialize(new ConnectionFile { Connections = next }, ConnectionJsonContext.Default.ConnectionFile);
        string? dir = Path.GetDirectoryName(Path.GetFullPath(FilePath));
        if (dir is not null)
        {
            Directory.CreateDirectory(dir);
        }

        string temp = FilePath + ".tmp";
        File.WriteAllText(temp, json + Environment.NewLine);
        File.Move(temp, FilePath, overwrite: true);
        _entries = next;
    }
}
