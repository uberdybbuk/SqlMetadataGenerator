using System.Data.Common;
using SqlMetadataGenerator.Model;

namespace SqlMetadataGenerator.Providers;

// The catalog, as the browser needs it, on PostgreSQL.
//
// This is NOT the generator's reader. It fills in exactly what the web asks for — the schema
// list, and enough of each table for the relationship diagram: name, columns and primary key.
// Indexes, checks and foreign keys stay empty, because the diagram infers relationships from
// COLUMN NAMES and never reads a constraint (RelationshipInference says why), and the script
// generator, which does need all of it, does not run against PostgreSQL.
//
// Two reads, not one per table: a 233-table schema would otherwise be 233 round trips.
public sealed class PgCatalogReader(string connectionString) : ICatalogReader
{
    private const DatabaseProvider Pg = DatabaseProvider.Postgres;

    private const string UserSchemas =
        "n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'";

    public async Task<List<SchemaInfo>> ReadSchemasAsync(CancellationToken ct = default)
    {
        string sql = $"""
            SELECT n.nspname, pg_get_userbyid(n.nspowner)
            FROM pg_namespace n
            WHERE {UserSchemas}
            ORDER BY n.nspname
            """;

        var schemas = new List<SchemaInfo>();
        await using var conn = await Db.OpenAsync(Pg, connectionString, ct);
        await using var cmd = Db.ReadOnly(Pg, conn, sql);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            schemas.Add(new SchemaInfo { Name = reader.GetString(0), Owner = reader.GetString(1) });
        }
        return schemas;
    }

    public async Task<List<TableInfo>> ReadTablesAsync(IProgress<int>? progress = null, CancellationToken ct = default)
    {
        await using var conn = await Db.OpenAsync(Pg, connectionString, ct);

        // Npgsql has no MARS, so the two reads run one after the other and each closes its
        // reader before the next command is issued.
        var columns = await ReadColumnsAsync(conn, ct);
        progress?.Report(1);
        var keys = await ReadPrimaryKeysAsync(conn, ct);
        progress?.Report(1);

        var tables = new List<TableInfo>();
        foreach (var ((schema, name), cols) in columns)
        {
            tables.Add(new TableInfo
            {
                Name = new ObjectName(schema, name),
                Columns = cols,
                PrimaryKey = keys.GetValueOrDefault((schema, name)),
            });
        }
        return tables;
    }

    private static async Task<Dictionary<(string Schema, string Name), List<ColumnInfo>>> ReadColumnsAsync(
        DbConnection conn, CancellationToken ct)
    {
        // format_type writes the standard spelling; PgDataExplorer.BaseType shortens it the same
        // way the table page does, so a column reads "varchar" on both screens.
        string sql = $"""
            SELECT n.nspname, c.relname, a.attname, a.attnum,
                   format_type(a.atttypid, NULL),
                   NOT a.attnotnull,
                   a.attidentity <> '' OR pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) IS NOT NULL,
                   a.attgenerated <> ''
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped AND {UserSchemas}
            ORDER BY n.nspname, c.relname, a.attnum
            """;

        var map = new Dictionary<(string, string), List<ColumnInfo>>();
        await using var cmd = Db.ReadOnly(Pg, conn, sql);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            var key = (reader.GetString(0), reader.GetString(1));
            if (!map.TryGetValue(key, out var list))
            {
                list = [];
                map[key] = list;
            }
            list.Add(new ColumnInfo
            {
                Name = reader.GetString(2),
                ColumnId = reader.GetInt16(3),
                TypeName = PgDataExplorer.BaseType(reader.GetString(4)),
                IsUserDefinedType = false,
                // The SQL Server fields these three mirror are only read by the scripter, which
                // does not run here. The diagram uses the type name.
                MaxLength = 0,
                Precision = 0,
                Scale = 0,
                IsNullable = reader.GetBoolean(5),
                IsIdentity = reader.GetBoolean(6),
                IsComputed = reader.GetBoolean(7),
            });
        }
        return map;
    }

    private static async Task<Dictionary<(string Schema, string Name), PrimaryKeyInfo>> ReadPrimaryKeysAsync(
        DbConnection conn, CancellationToken ct)
    {
        // The key columns come back in KEY order, which array_position against indkey gives and
        // a plain join does not: a two-column key read in attnum order would be silently
        // reversed for half the tables that have one.
        string sql = $"""
            SELECT n.nspname, c.relname, con.conname,
                   array_agg(a.attname ORDER BY array_position(i.indkey, a.attnum))
            FROM pg_constraint con
            JOIN pg_class c ON c.oid = con.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_index i ON i.indexrelid = con.conindid
            JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
            WHERE con.contype = 'p' AND {UserSchemas}
            GROUP BY n.nspname, c.relname, con.conname
            """;

        var map = new Dictionary<(string, string), PrimaryKeyInfo>();
        await using var cmd = Db.ReadOnly(Pg, conn, sql);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            var names = reader.GetFieldValue<string[]>(3);
            map[(reader.GetString(0), reader.GetString(1))] = new PrimaryKeyInfo
            {
                Name = reader.GetString(2),
                // PostgreSQL has no clustered index; CLUSTER is a one-off reorder, not a
                // property of the key.
                IsClustered = false,
                Columns = [.. names.Select(x => (x, false))],
            };
        }
        return map;
    }
}
