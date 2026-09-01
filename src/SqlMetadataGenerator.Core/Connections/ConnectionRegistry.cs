using System.Text.Json;
using Microsoft.Data.SqlClient;

namespace SqlMetadataGenerator.Connections;

// connections.json'ı okur ve alias -> bağlantı dizesi çözümlemesini yapar.
// Alias URL'de segment olduğu için slug kurallarına zorlanır; böylece encode derdi
// ve gerçek sunucu adlarındaki ',' / '\' karakterlerinin yarattığı kırılganlık olmaz.
public sealed class ConnectionRegistry
{
    private readonly Dictionary<string, ConnectionEntry> _byAlias;

    private ConnectionRegistry(Dictionary<string, ConnectionEntry> byAlias)
    {
        _byAlias = byAlias;
    }

    public IReadOnlyCollection<ConnectionEntry> All => _byAlias.Values;

    public static ConnectionRegistry Empty { get; } = new(new Dictionary<string, ConnectionEntry>(StringComparer.OrdinalIgnoreCase));

    // Dosya yoksa boş kayıt döner (uygulama yine ayağa kalkar, sadece bağlantı listesi boştur).
    // Bozuk JSON veya geçersiz alias sessizce yutulmaz: açık hata fırlatılır.
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
            throw new InvalidOperationException($"'{path}' okunamadı: {ex.Message}", ex);
        }

        var byAlias = new Dictionary<string, ConnectionEntry>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in file?.Connections ?? [])
        {
            if (!IsValidAlias(entry.Alias))
            {
                throw new InvalidOperationException(
                    $"Geçersiz alias: '{entry.Alias}'. Yalnızca harf, rakam, '-' ve '_' kullanılabilir ve harf/rakamla başlamalı.");
            }

            if (!byAlias.TryAdd(entry.Alias, entry))
            {
                throw new InvalidOperationException($"Alias birden fazla kez tanımlanmış: '{entry.Alias}'.");
            }
        }

        return new ConnectionRegistry(byAlias);
    }

    public ConnectionEntry? Find(string alias) => _byAlias.GetValueOrDefault(alias);

    // Bağlantı dizesini üretir. database null ise sunucu seviyesi sorgular için 'master' kullanılır.
    // SQL auth'ta parola ortam değişkeninden okunur; yoksa hangi değişkenin beklendiğini söyleyen hata verilir.
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
                $"'{entry.Alias}' için parola bulunamadı. '{envName}' ortam değişkenini ayarlayın.");
        }

        builder.UserID = entry.User ?? string.Empty;
        builder.Password = password;
        return builder.ConnectionString;
    }

    // Alias kuralı: ASCII harf/rakamla başlar, devamında ASCII harf, rakam, '-' veya '_'.
    // Unicode harfler (ör. 'ş') bilerek dışarıda: URL'de encode gerektirir, elle yazılamaz.
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
