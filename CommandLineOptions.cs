using Microsoft.Data.SqlClient;
using SqlMetadataGenerator.Scripting;

namespace SqlMetadataGenerator;

public enum AuthMode
{
    Sql,
    Integrated,
    AzureAd
}

/// <summary>
/// Komut satırı argümanlarından oluşan bağlantı ve çıktı ayarları.
/// </summary>
public sealed class CommandLineOptions
{
    public required string Server { get; init; }
    public required string Database { get; init; }
    public AuthMode AuthMode { get; init; } = AuthMode.Sql;
    public string? User { get; init; }
    public string? Password { get; init; }
    public bool TrustServerCertificate { get; init; }
    public bool Encrypt { get; init; } = true;
    public string OutputRoot { get; init; } = "./output";
    public KeywordCase KeywordCase { get; init; } = KeywordCase.Lower;
    public bool EmitSetOptions { get; init; }
    /// <summary>null ise ScriptFormat'ın varsayılan audit kolon listesi kullanılır.</summary>
    public IReadOnlySet<string>? AuditColumns { get; init; }
    /// <summary>true ise snapshot yok sayılır ve tüm nesneler yeniden çekilir.</summary>
    public bool FullRefresh { get; init; }
    /// <summary>Tip/şema/isim bazlı dışlama filtresi.</summary>
    public ObjectFilter Filter { get; init; } = ObjectFilter.Empty;

    public ScriptFormat ToScriptFormat(string? databaseCollation = null) => new()
    {
        KeywordCase = KeywordCase,
        EmitSetOptions = EmitSetOptions,
        DatabaseCollation = databaseCollation,
        AuditColumns = AuditColumns ?? ScriptFormat.DefaultAuditColumns,
    };

    public string BuildConnectionString()
    {
        var builder = new SqlConnectionStringBuilder
        {
            DataSource = Server,
            InitialCatalog = Database,
            TrustServerCertificate = TrustServerCertificate,
            Encrypt = Encrypt,
            ApplicationName = "SqlMetadataGenerator",
        };

        switch (AuthMode)
        {
            case AuthMode.Sql:
                builder.UserID = User ?? string.Empty;
                builder.Password = Password ?? string.Empty;
                break;
            case AuthMode.Integrated:
                builder.IntegratedSecurity = true;
                break;
            case AuthMode.AzureAd:
                // İnteraktif Azure AD; kullanıcı/parola verildiyse password akışı kullanılır.
#pragma warning disable CS0618 // ActiveDirectoryPassword obsolete; kullanıcı/parola verildiyse hâlâ tek seçenek
                builder.Authentication = string.IsNullOrEmpty(User)
                    ? SqlAuthenticationMethod.ActiveDirectoryInteractive
                    : SqlAuthenticationMethod.ActiveDirectoryPassword;
#pragma warning restore CS0618
                if (!string.IsNullOrEmpty(User))
                {
                    builder.UserID = User;
                    builder.Password = Password ?? string.Empty;
                }
                break;
        }

        return builder.ConnectionString;
    }

    /// <summary>
    /// Argümanları parse eder. Hata varsa <paramref name="error"/> dolar ve null döner.
    /// </summary>
    public static CommandLineOptions? Parse(string[] args, out string? error)
    {
        error = null;
        string? err = null;
        string? server = null, database = null, user = null, password = null;
        var authMode = AuthMode.Sql;
        bool trust = false, encrypt = true, authExplicit = false;
        string output = "./output";
        var keywordCase = KeywordCase.Lower;
        bool emitSetOptions = false;
        IReadOnlySet<string>? auditColumns = null;
        bool fullRefresh = false;
        string[] excludeTypes = [], excludeSchemas = [], excludeNames = [];

        for (int i = 0; i < args.Length; i++)
        {
            string arg = args[i];
            string? Next()
            {
                if (i + 1 >= args.Length)
                {
                    err = $"'{arg}' için değer eksik.";
                    return null;
                }
                return args[++i];
            }

            switch (arg)
            {
                case "-s" or "--server":
                    server = Next();
                    break;
                case "-d" or "--database":
                    database = Next();
                    break;
                case "-u" or "--user":
                    user = Next();
                    break;
                case "-p" or "--password":
                    password = Next();
                    break;
                case "-o" or "--output":
                    output = Next() ?? output;
                    break;
                case "--integrated":
                    authMode = AuthMode.Integrated;
                    authExplicit = true;
                    break;
                case "--azure-ad":
                    authMode = AuthMode.AzureAd;
                    authExplicit = true;
                    break;
                case "--trust-server-certificate" or "--trust":
                    trust = true;
                    break;
                case "--no-encrypt":
                    encrypt = false;
                    break;
                case "--keyword-case":
                    string? kc = Next();
                    if (kc is not null)
                    {
                        if (kc.Equals("upper", StringComparison.OrdinalIgnoreCase))
                            keywordCase = KeywordCase.Upper;
                        else if (kc.Equals("lower", StringComparison.OrdinalIgnoreCase))
                            keywordCase = KeywordCase.Lower;
                        else
                            err = $"--keyword-case 'lower' veya 'upper' olmalı (verilen: {kc}).";
                    }
                    break;
                case "--set-options":
                    emitSetOptions = true;
                    break;
                case "--full":
                    fullRefresh = true;
                    break;
                case "--exclude":
                    excludeTypes = SplitList(Next());
                    foreach (var t in excludeTypes)
                        if (!ObjectFilter.ValidTypes.Contains(t))
                        {
                            err = $"Geçersiz --exclude tipi: '{t}'. Geçerli: {string.Join(", ", ObjectFilter.ValidTypes)}";
                            break;
                        }
                    break;
                case "--exclude-schema":
                    excludeSchemas = SplitList(Next());
                    break;
                case "--exclude-name":
                    excludeNames = SplitList(Next());
                    break;
                case "--audit-columns":
                    string? list = Next();
                    if (list is not null)
                    {
                        var cols = list
                            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                        auditColumns = new HashSet<string>(cols, StringComparer.OrdinalIgnoreCase);
                    }
                    break;
                default:
                    err = $"Bilinmeyen argüman: {arg}";
                    break;
            }

            if (err is not null)
            {
                error = err;
                return null;
            }
        }

        // Auth açıkça verilmediyse ama kullanıcı/parola varsa SQL auth varsay.
        if (!authExplicit && (user is not null || password is not null))
            authMode = AuthMode.Sql;

        if (string.IsNullOrWhiteSpace(server))
        {
            error = "--server zorunludur.";
            return null;
        }
        if (string.IsNullOrWhiteSpace(database))
        {
            error = "--database zorunludur.";
            return null;
        }
        if (authMode == AuthMode.Sql && string.IsNullOrWhiteSpace(user))
        {
            error = "SQL auth için --user (ve --password) gereklidir. Windows auth için --integrated, Azure AD için --azure-ad kullanın.";
            return null;
        }

        return new CommandLineOptions
        {
            Server = server,
            Database = database,
            AuthMode = authMode,
            User = user,
            Password = password,
            TrustServerCertificate = trust,
            Encrypt = encrypt,
            OutputRoot = output,
            KeywordCase = keywordCase,
            EmitSetOptions = emitSetOptions,
            AuditColumns = auditColumns,
            FullRefresh = fullRefresh,
            Filter = new ObjectFilter(excludeTypes, excludeSchemas, excludeNames),
        };
    }

    private static string[] SplitList(string? value) =>
        value is null
            ? []
            : value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    public static string UsageText =>
        """
        Kullanım:
          dotnet run -- --server <sunucu> --database <db> [seçenekler]

        Zorunlu:
          -s, --server <ad>           SQL Server adı/adresi (örn. localhost,1433)
          -d, --database <ad>         Veritabanı adı

        Kimlik doğrulama (biri):
          -u, --user <ad>             SQL auth kullanıcı adı (varsayılan mod)
          -p, --password <parola>     SQL auth / Azure AD parolası
          --integrated                Windows Integrated Security
          --azure-ad                  Azure AD (kullanıcı yoksa interaktif)

        Diğer:
          -o, --output <yol>          Çıktı kök dizini (varsayılan: ./output)
          --trust, --trust-server-certificate   Sunucu sertifikasına güven
          --no-encrypt                Şifrelemeyi kapat
          --keyword-case <lower|upper>  Anahtar kelime büyük/küçük harfi (varsayılan: lower)
          --set-options               SET ANSI_NULLS / QUOTED_IDENTIFIER bloklarını ekle
          --audit-columns "a,b,c"     Audit kolonları (ardışık grup boş satırla ayrılır).
                                      Varsayılan: CreatedAt,CreatedBy,IsActive,UpdatedAt,
                                      UpdatedBy,UpdatedCorrelationId,UpdatedChannelCode
          --full                      Snapshot'ı yok say, tüm nesneleri yeniden çek
                                      (varsayılan: snapshot varsa incremental)

        Dışlama (exclusion):
          --exclude <tipler>          Dışlanan tipler: schemas,tables,views,
                                      procedures,functions,triggers,synonyms
          --exclude-schema <şemalar>  Bu şemalardaki tüm nesneleri atla
          --exclude-name <metinler>   Adında bu metinlerden biri geçen nesneleri atla
        """;
}
