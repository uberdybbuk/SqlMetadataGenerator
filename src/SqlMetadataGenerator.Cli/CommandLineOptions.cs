using Microsoft.Data.SqlClient;
using SqlMetadataGenerator.Scripting;

namespace SqlMetadataGenerator;

public enum AuthMode
{
    Sql,
    Integrated,
}

// The command-line arguments. The properties are grouped by how they are used.
public sealed class CommandLineOptions
{
    // --- Connection, authentication and security ---
    public required string Server { get; init; }
    public required string Database { get; init; }
    public AuthMode AuthMode { get; init; } = AuthMode.Sql;
    public string? User { get; init; }
    public string? Password { get; init; }
    // The server certificate is trusted by default (convenience in a development environment); --no-trust turns that off.
    public bool TrustServerCertificate { get; init; } = true;
    public bool Encrypt { get; init; } = true;

    // --- Script generation (output + formatting) ---
    public string OutputRoot { get; init; } = "./output";
    public KeywordCase KeywordCase { get; init; } = KeywordCase.Lower;
    public bool EmitSetOptions { get; init; }
    public bool GroupColumns { get; init; } = true;
    // When null, the default audit column list from ScriptFormat is used.
    public IReadOnlySet<string>? AuditColumns { get; init; }

    // --- Incremental ---
    // When true the snapshot is ignored and every object is fetched again.
    public bool FullRefresh { get; init; }

    // --- Exclusion ---
    public ObjectFilter Filter { get; init; } = ObjectFilter.Empty;

    // --- Deploy ---
    // When true, applies the source files to the target database instead of generating scripts.
    public bool Deploy { get; init; }
    // In deploy mode, the source database-root directory (the one holding Tables/, Views/ ...).
    public string? SourceDir { get; init; }

    public ScriptFormat ToScriptFormat(string? databaseCollation = null) => new()
    {
        KeywordCase = KeywordCase,
        EmitSetOptions = EmitSetOptions,
        GroupColumns = GroupColumns,
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
        }

        return builder.ConnectionString;
    }

    // Parses the arguments. On failure error is filled in and null is returned.
    public static CommandLineOptions? Parse(string[] args, out string? error)
    {
        error = null;
        string? err = null;

        // Connection, authentication and security
        string? server = null, database = null, user = null, password = null;
        var authMode = AuthMode.Sql;
        bool trust = true, encrypt = true, authExplicit = false;
        // Script generation
        string output = "./output";
        var keywordCase = KeywordCase.Lower;
        bool emitSetOptions = false;
        bool groupColumns = true;
        IReadOnlySet<string>? auditColumns = null;
        // Incremental
        bool fullRefresh = false;
        // Exclusion
        string[] excludeTypes = [], excludeSchemas = [], excludeNames = [];
        // Deploy
        bool deploy = false;
        string? sourceDir = null;

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
                // Connection, authentication and security
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
                case "--integrated":
                    authMode = AuthMode.Integrated;
                    authExplicit = true;
                    break;
                case "--no-trust":
                    trust = false;
                    break;
                case "--no-encrypt":
                    encrypt = false;
                    break;

                // Script generation
                case "-o" or "--output":
                    output = Next() ?? output;
                    break;
                case "--keyword-case":
                    string? kc = Next();
                    if (kc is not null)
                    {
                        if (kc.Equals("upper", StringComparison.OrdinalIgnoreCase))
                        {
                            keywordCase = KeywordCase.Upper;
                        }
                        else if (kc.Equals("lower", StringComparison.OrdinalIgnoreCase))
                        {
                            keywordCase = KeywordCase.Lower;
                        }
                        else
                        {
                            err = $"--keyword-case 'lower' veya 'upper' olmalı (verilen: {kc}).";
                        }
                    }
                    break;
                case "--set-options":
                    emitSetOptions = true;
                    break;
                case "--no-group-columns":
                    groupColumns = false;
                    break;
                case "--audit-columns":
                    auditColumns = SplitList(Next()) is { Length: > 0 } cols
                        ? new HashSet<string>(cols, StringComparer.OrdinalIgnoreCase)
                        : null;
                    break;

                // Incremental
                case "--full":
                    fullRefresh = true;
                    break;

                // Exclusion
                case "--exclude":
                    excludeTypes = SplitList(Next());
                    foreach (var t in excludeTypes)
                    {
                        if (!ObjectFilter.ValidTypes.Contains(t))
                        {
                            err = $"Geçersiz --exclude tipi: '{t}'. Geçerli: {string.Join(", ", ObjectFilter.ValidTypes)}";
                            break;
                        }
                    }
                    break;
                case "--exclude-schema":
                    excludeSchemas = SplitList(Next());
                    break;
                case "--exclude-name":
                    excludeNames = SplitList(Next());
                    break;

                // Deploy
                case "--deploy":
                    deploy = true;
                    break;
                case "--source":
                    sourceDir = Next();
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

        // When auth was not given explicitly but a user or password was, assume SQL auth.
        if (!authExplicit && (user is not null || password is not null))
        {
            authMode = AuthMode.Sql;
        }

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
            error = "SQL auth için --user (ve --password) gereklidir. Windows auth için --integrated kullanın.";
            return null;
        }
        if (deploy && string.IsNullOrWhiteSpace(sourceDir))
        {
            error = "--deploy için --source <dizin> gereklidir (kaynak database-root klasörü).";
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
            GroupColumns = groupColumns,
            AuditColumns = auditColumns,
            FullRefresh = fullRefresh,
            Filter = new ObjectFilter(excludeTypes, excludeSchemas, excludeNames),
            Deploy = deploy,
            SourceDir = sourceDir,
        };
    }

    private static string[] SplitList(string? value) =>
        value is null
            ? []
            : value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    public static string UsageText =>
        """
        Kullanım:
          dotnet run --project src/SqlMetadataGenerator.Cli -- --server <sunucu> --database <db> [seçenekler]

        Bağlantı, kimlik doğrulama ve güvenlik:
          -s, --server <ad>           SQL Server adı/adresi (örn. localhost,1433)
          -d, --database <ad>         Veritabanı adı
          -u, --user <ad>             SQL auth kullanıcı adı (varsayılan mod)
          -p, --password <parola>     SQL auth parolası
          --integrated                Windows Integrated Security
          --no-trust                  Sunucu sertifikasını doğrula (varsayılan: güven)
          --no-encrypt                Şifrelemeyi kapat

        Script üretimi:
          -o, --output <yol>          Çıktı kök dizini (varsayılan: ./output)
          --keyword-case <lower|upper>  Anahtar kelime büyük/küçük harfi (varsayılan: lower)
          --set-options               SET ANSI_NULLS / QUOTED_IDENTIFIER bloklarını ekle
          --no-group-columns          Kolonları ortak kelimeye göre gruplama (varsayılan: açık)
          --audit-columns "a,b,c"     Audit kolonları (ardışık grup boş satırla ayrılır).
                                      Varsayılan: CreatedAt,CreatedBy,IsActive,UpdatedAt,
                                      UpdatedBy,UpdatedCorrelationId,UpdatedChannelCode

        Incremental:
          --full                      Snapshot'ı yok say, tüm nesneleri yeniden çek
                                      (varsayılan: snapshot varsa incremental)

        Dışlama:
          --exclude <tipler>          schemas,sequences,types,tables,views,
                                      procedures,functions,triggers,synonyms
          --exclude-schema <şemalar>  Bu şemalardaki tüm nesneleri atla
          --exclude-name <metinler>   Adında bu metinlerden biri geçen nesneleri atla

        Deploy (dosyalardan veritabanı oluşturma):
          --deploy                    Script üretmek yerine kaynak dosyaları hedefe uygula
          --source <dizin>            Kaynak database-root klasörü (Tables/, Views/ ...)
                                      Hedef yine --server/--database/--user ile verilir.
        """;
}
