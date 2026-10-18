using SqlMetadataGenerator.Exploration;

namespace SqlMetadataGenerator.Providers;

// The server level on PostgreSQL: which engine this is, and which databases it holds.
//
// Several things SQL Server reports have no counterpart here — a recovery model, a
// compatibility level, a per-database creation date, a per-database log size. Those come back
// null rather than as a plausible-looking zero, and the UI shows a dash.
public sealed class PgServerExplorer(string connectionString) : IServerExplorer
{
    public async Task<ServerInfo> ReadServerInfoAsync(CancellationToken ct = default)
    {
        const string sql = """
            SELECT current_setting('server_version'),
                   split_part(version(), ' on ', 2),
                   (SELECT datcollate FROM pg_database WHERE datname = current_database()),
                   COALESCE(host(inet_server_addr()), 'local')
            """;

        await using var conn = await Db.OpenAsync(DatabaseProvider.Postgres, connectionString, ct);
        await using var cmd = Db.ReadOnly(DatabaseProvider.Postgres, conn, sql);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        await reader.ReadAsync(ct);

        return new ServerInfo
        {
            Product = "PostgreSQL",
            ProductVersion = reader.IsDBNull(0) ? "?" : reader.GetString(0),
            // There is no service pack or cumulative update here; the build platform is the
            // closest useful thing and it is what psql shows.
            ProductLevel = string.Empty,
            Edition = reader.IsDBNull(1) ? string.Empty : reader.GetString(1).Trim(),
            Collation = reader.IsDBNull(2) ? "?" : reader.GetString(2),
            MachineName = reader.IsDBNull(3) ? "local" : reader.GetString(3),
        };
    }

    public async Task<List<DatabaseInfo>> ReadDatabasesAsync(CancellationToken ct = default)
    {
        // Template databases are machinery, not something to browse. A database the current
        // login may not connect to is listed but marked, the same as an offline one on SQL
        // Server — pg_database_size would also fail on it, hence the guard.
        const string sql = """
            SELECT d.datname,
                   d.datallowconn AND has_database_privilege(d.datname, 'CONNECT') AS usable,
                   d.datcollate,
                   CASE WHEN has_database_privilege(d.datname, 'CONNECT')
                        THEN pg_database_size(d.oid) / 1048576 ELSE 0 END AS data_mb
            FROM pg_database d
            WHERE NOT d.datistemplate
            ORDER BY d.datname
            """;

        var list = new List<DatabaseInfo>();
        await using var conn = await Db.OpenAsync(DatabaseProvider.Postgres, connectionString, ct);
        await using var cmd = Db.ReadOnly(DatabaseProvider.Postgres, conn, sql);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            list.Add(new DatabaseInfo
            {
                Name = reader.GetString(0),
                // IsBrowsable keys off this word, so it has to be the same word SQL Server uses.
                State = reader.GetBoolean(1) ? "ONLINE" : "OFFLINE",
                RecoveryModel = null,
                CompatibilityLevel = null,
                Collation = reader.IsDBNull(2) ? null : reader.GetString(2),
                CreateDate = null,
                DataMb = reader.GetInt64(3),
                LogMb = null,
            });
        }

        return list;
    }
}
