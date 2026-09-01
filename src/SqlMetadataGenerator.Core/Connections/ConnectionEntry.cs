using System.Text.Json;
using System.Text.Json.Serialization;

namespace SqlMetadataGenerator.Connections;

// connections.json içindeki tek bir kayıt. Parola BİLEREK yok: yalnızca hangi ortam
// değişkeninden okunacağı tutulur, böylece dosya repoya girse bile sır sızmaz.
public sealed class ConnectionEntry
{
    // URL'de segment olarak kullanılır; bu yüzden slug kurallarına uymak zorunda.
    public required string Alias { get; set; }
    public required string Server { get; set; }
    // "sql" veya "integrated".
    public string Auth { get; set; } = "sql";
    public string? User { get; set; }
    // Parolanın okunacağı ortam değişkeni. Verilmezse SQLMETA_PW_{ALIAS} varsayılır.
    public string? PasswordEnv { get; set; }
    public bool TrustServerCertificate { get; set; } = true;
    public bool Encrypt { get; set; } = true;
    // UI'da gösterilecek serbest açıklama.
    public string? Description { get; set; }

    // Parola verilmediğinde bakılacak varsayılan ortam değişkeni adı.
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
