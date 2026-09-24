using System.Text.Json;
using System.Text.Json.Serialization;

namespace SqlMetadataGenerator.Connections;

// A single record inside connections.json. The password may be stored here in clear text (the
// connection screen writes it); connections*.json is ignored by Git for exactly that reason.
// When no password is stored, it is read from the environment variable PasswordEnv names.
public sealed class ConnectionEntry
{
    // Used as a URL segment, which is why it has to obey the slug rules.
    public required string Alias { get; set; }
    public required string Server { get; set; }
    // Either "sql" or "integrated".
    public string Auth { get; set; } = "sql";
    public string? User { get; set; }
    // Clear text. Takes precedence over PasswordEnv when set. Never returned by the API.
    public string? Password { get; set; }
    // The environment variable the password is read from. Defaults to SQLMETA_PW_{ALIAS}.
    public string? PasswordEnv { get; set; }
    public bool TrustServerCertificate { get; set; } = true;
    public bool Encrypt { get; set; } = true;
    // Free-form description shown in the UI.
    public string? Description { get; set; }

    [JsonIgnore]
    public bool IsIntegrated => Auth.Equals("integrated", StringComparison.OrdinalIgnoreCase);

    [JsonIgnore]
    public bool HasStoredPassword => !string.IsNullOrEmpty(Password);

    // The default environment variable name to look at when none is given.
    [JsonIgnore]
    public string ResolvedPasswordEnv =>
        string.IsNullOrWhiteSpace(PasswordEnv)
            ? "SQLMETA_PW_" + new string(Alias.Select(c => char.IsLetterOrDigit(c) ? char.ToUpperInvariant(c) : '_').ToArray())
            : PasswordEnv;
}

public sealed class ConnectionFile
{
    public List<ConnectionEntry> Connections { get; set; } = [];
}

// Nulls are left out when writing, so a Windows-auth entry saved from the UI does not carry
// "user": null, "password": null lines a person would then have to read past.
[JsonSourceGenerationOptions(
    WriteIndented = true,
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    PropertyNameCaseInsensitive = true,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(ConnectionFile))]
internal partial class ConnectionJsonContext : JsonSerializerContext;
