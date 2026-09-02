using System.Text.Json;
using Microsoft.Data.SqlClient;

namespace SqlMetadataGenerator.Connections;

// Reads connections.json and resolves an alias to a connection string.
// The alias is forced to the slug rules because it is a URL segment; that avoids both the
// encoding hassle and the fragility that ',' and '\' in real server names would cause.
public sealed class ConnectionRegistry
{
    private readonly Dictionary<string, ConnectionEntry> _byAlias;

    private ConnectionRegistry(Dictionary<string, ConnectionEntry> byAlias)
    {
        _byAlias = byAlias;
    }

    public IReadOnlyCollection<ConnectionEntry> All => _byAlias.Values;

    public static ConnectionRegistry Empty { get; } = new(new Dictionary<string, ConnectionEntry>(StringComparer.OrdinalIgnoreCase));

    // Returns an empty registry when the file is missing (the app still starts, only the connection list is empty).
    // Broken JSON or an invalid alias is never swallowed: it throws an explicit error.
    public static ConnectionRegistry Load(string path)
    {
        if (!File.Exists(path))
        {
            return Empty;
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

        var byAlias = new Dictionary<string, ConnectionEntry>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in file?.Connections ?? [])
        {
            if (!IsValidAlias(entry.Alias))
            {
                throw new InvalidOperationException(
                    $"Invalid alias '{entry.Alias}'. Use only letters, digits, '-' and '_', starting with a letter or digit.");
            }

            if (!byAlias.TryAdd(entry.Alias, entry))
            {
                throw new InvalidOperationException($"Alias defined more than once: '{entry.Alias}'.");
            }
        }

        return new ConnectionRegistry(byAlias);
    }

    public ConnectionEntry? Find(string alias) => _byAlias.GetValueOrDefault(alias);

    // Builds the connection string. When database is null, server-level queries use 'master'.
    // Under SQL auth the password comes from the environment; without it the error names the variable that was expected.
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

        if (entry.Auth.Equals("integrated", StringComparison.OrdinalIgnoreCase))
        {
            builder.IntegratedSecurity = true;
            return builder.ConnectionString;
        }

        string envName = entry.ResolvedPasswordEnv;
        string? password = Environment.GetEnvironmentVariable(envName);
        if (string.IsNullOrEmpty(password))
        {
            throw new InvalidOperationException(
                $"No password for '{entry.Alias}'. Set the '{envName}' environment variable.");
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
}
