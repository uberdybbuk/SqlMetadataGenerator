using System.Text.Json;
using System.Text.Json.Serialization;

namespace SqlMetadataGenerator.Connections;

// A single record inside connections.json. The password is DELIBERATELY absent: only the
// environment variable it is read from is stored, so no secret leaks even if the file is committed.
public sealed class ConnectionEntry
{
    // Used as a URL segment, which is why it has to obey the slug rules.
    public required string Alias { get; set; }
    public required string Server { get; set; }
    // Either "sql" or "integrated".
    public string Auth { get; set; } = "sql";
    public string? User { get; set; }
    // The environment variable the password is read from. Defaults to SQLMETA_PW_{ALIAS}.
    public string? PasswordEnv { get; set; }
    public bool TrustServerCertificate { get; set; } = true;
    public bool Encrypt { get; set; } = true;
    // Free-form description shown in the UI.
    public string? Description { get; set; }

    // The default environment variable name to look at when none is given.
    public string ResolvedPasswordEnv =>
        string.IsNullOrWhiteSpace(PasswordEnv)
            ? "SQLMETA_PW_" + new string(Alias.Select(c => char.IsLetterOrDigit(c) ? char.ToUpperInvariant(c) : '_').ToArray())
            : PasswordEnv;
}

public sealed class ConnectionFile
{
    public List<ConnectionEntry> Connections { get; set; } = [];
}

[JsonSourceGenerationOptions(
    WriteIndented = true,
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    PropertyNameCaseInsensitive = true)]
[JsonSerializable(typeof(ConnectionFile))]
internal partial class ConnectionJsonContext : JsonSerializerContext;
