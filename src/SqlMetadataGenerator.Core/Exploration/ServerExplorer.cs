using Microsoft.Data.SqlClient;

namespace SqlMetadataGenerator.Exploration;

// Sunucu seviyesi keşif: sürüm bilgisi ve veritabanı listesi.
// Bağlantı 'master'a açılır; veritabanı başına AYRI bağlantı açılmaz (SMO'nun aksine),
// çünkü sys.master_files sunucu genelindedir.
public sealed class ServerExplorer(string connectionString)
{
    private readonly string _connectionString = connectionString;

    private async Task<SqlConnection> OpenAsync(CancellationToken ct)
    {
        var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        return conn;
    }

    public async Task<ServerInfo> ReadServerInfoAsync(CancellationToken ct = default)
    {
        // SERVERPROPERTY sql_variant döner; CONVERT edilmezse sürücü de istemci de
        // gereksiz geniş alan ayırır.
        const string sql = """
            SELECT
                CONVERT(nvarchar(64),  SERVERPROPERTY('ProductVersion')),
                CONVERT(nvarchar(64),  SERVERPROPERTY('ProductLevel')),
                CONVERT(nvarchar(128), SERVERPROPERTY('Edition')),
                CONVERT(nvarchar(128), SERVERPROPERTY('Collation')),
                CONVERT(nvarchar(128), SERVERPROPERTY('MachineName'));
            """;

        await using var conn = await OpenAsync(ct);
        await using var cmd = ReadOnlyCommand.Create(conn, sql);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct))
        {
            throw new InvalidOperationException("Could not read server information.");
        }

        return new ServerInfo
        {
            ProductVersion = reader.IsDBNull(0) ? "?" : reader.GetString(0),
            ProductLevel = reader.IsDBNull(1) ? "?" : reader.GetString(1),
            Edition = reader.IsDBNull(2) ? "?" : reader.GetString(2),
            Collation = reader.IsDBNull(3) ? "?" : reader.GetString(3),
            MachineName = reader.IsDBNull(4) ? "?" : reader.GetString(4),
        };
    }

    // Tüm veritabanlarını boyutlarıyla birlikte TEK sorguda döner.
    // sys.databases izne göre filtrelenir: yetkisi olmayan kullanıcı yalnızca kendi
    // veritabanlarını görür — bu bir hata değil, normal davranıştır.
    public async Task<List<DatabaseInfo>> ReadDatabasesAsync(CancellationToken ct = default)
    {
        // SUM içinde ELSE 0 şart: atlanırsa "Null value is eliminated by an aggregate" uyarısı gelir.
        const string sql = """
            SELECT
                d.name,
                d.state_desc,
                d.recovery_model_desc,
                d.compatibility_level,
                d.collation_name,
                d.create_date,
                SUM(CASE WHEN mf.type = 0 THEN CONVERT(bigint, mf.size) ELSE 0 END) * 8 / 1024 AS data_mb,
                SUM(CASE WHEN mf.type = 1 THEN CONVERT(bigint, mf.size) ELSE 0 END) * 8 / 1024 AS log_mb
            FROM sys.databases d
            LEFT JOIN sys.master_files mf ON mf.database_id = d.database_id
            GROUP BY d.name, d.state_desc, d.recovery_model_desc, d.compatibility_level,
                     d.collation_name, d.create_date
            ORDER BY d.name;
            """;

        var list = new List<DatabaseInfo>();
        await using var conn = await OpenAsync(ct);
        await using var cmd = ReadOnlyCommand.Create(conn, sql);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            list.Add(new DatabaseInfo
            {
                Name = reader.GetString(0),
                State = reader.GetString(1),
                RecoveryModel = reader.GetString(2),
                CompatibilityLevel = reader.GetByte(3),
                Collation = reader.IsDBNull(4) ? null : reader.GetString(4),
                CreateDate = reader.GetDateTime(5),
                DataMb = reader.GetInt64(6),
                LogMb = reader.GetInt64(7),
            });
        }

        return list;
    }
}
