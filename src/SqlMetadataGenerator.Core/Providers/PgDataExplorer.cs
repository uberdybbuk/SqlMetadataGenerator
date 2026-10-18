using System.Data.Common;
using System.Diagnostics;
using System.Globalization;
using SqlMetadataGenerator.Exploration;

namespace SqlMetadataGenerator.Providers;

// Browsing one PostgreSQL database.
//
// Same contract as the SQL Server explorer: every number comes from the catalog without
// scanning user data. reltuples is the planner's estimate, refreshed by ANALYZE, which is the
// direct counterpart of reading sys.partitions rather than counting rows.
//
// Two differences shape the code. Identifiers are always quoted (PgIdentifier explains why),
// and Npgsql allows only ONE open reader per connection — no MARS — so nothing here holds a
// reader open while issuing another command.
public sealed class PgDataExplorer(string connectionString) : IDataExplorer
{
    private const DatabaseProvider Pg = DatabaseProvider.Postgres;

    // How many characters a text column is truncated to in the preview, matching the SQL Server
    // explorer so the two grids behave the same.
    private const int TextLimit = 256;
    private const int BinaryBytes = 64;

    // Catalogs that belong to the engine, not to the user.
    private const string UserSchemas =
        "n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'";

    private Task<DbConnection> OpenAsync(CancellationToken ct) => Db.OpenAsync(Pg, connectionString, ct);

    public async Task<List<TableStats>> ReadTableStatsAsync(CancellationToken ct = default)
    {
        // reltuples is -1 on a table that has never been analysed, and that means UNKNOWN. It is
        // reported as null rather than clamped to 0, because every caller that cares — the row
        // column, the treemap colour, the scripting size warning — needs to tell the two apart.
        // There is no cheap substitute: relpages is 0 on the same tables, so the only way to a
        // number is counting rows, which is the scan this whole class exists to avoid.
        string sql = $"""
            SELECT n.nspname, c.relname,
                   CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END,
                   pg_total_relation_size(c.oid) / 1024,
                   pg_relation_size(c.oid) / 1024
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p') AND {UserSchemas}
            ORDER BY n.nspname, c.relname
            """;

        var list = new List<TableStats>();
        await using var conn = await OpenAsync(ct);
        await using var cmd = Db.ReadOnly(Pg, conn, sql);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            list.Add(new TableStats
            {
                Schema = reader.GetString(0),
                Name = reader.GetString(1),
                RowCount = reader.IsDBNull(2) ? null : reader.GetInt64(2),
                ReservedKb = reader.GetInt64(3),
                UsedKb = reader.GetInt64(4),
            });
        }
        return list;
    }

    public async Task<Dictionary<string, int>> ReadObjectCountsAsync(CancellationToken ct = default)
    {
        // The same vocabulary the dashboard badges use. Synonyms have no PostgreSQL counterpart
        // and are simply absent, which the badge list already handles by showing only non-zero
        // kinds.
        string sql = $"""
            SELECT 'tables', count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r','p') AND {UserSchemas}
            UNION ALL SELECT 'views', count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('v','m') AND {UserSchemas}
            UNION ALL SELECT 'sequences', count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind = 'S' AND {UserSchemas}
            UNION ALL SELECT 'procedures', count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE p.prokind = 'p' AND {UserSchemas}
            UNION ALL SELECT 'functions', count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE p.prokind IN ('f','a','w') AND {UserSchemas}
            UNION ALL SELECT 'triggers', count(*)::int FROM pg_trigger t
                JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE NOT t.tgisinternal AND {UserSchemas}
            UNION ALL SELECT 'types', count(*)::int FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                WHERE t.typtype IN ('c','d','e') AND {UserSchemas}
                  AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind <> 'c')
            UNION ALL SELECT 'schemas', count(*)::int FROM pg_namespace n WHERE {UserSchemas}
            """;

        var counts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        await using var conn = await OpenAsync(ct);
        await using var cmd = Db.ReadOnly(Pg, conn, sql);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            int n = reader.GetInt32(1);
            if (n > 0)
            {
                counts[reader.GetString(0)] = n;
            }
        }
        return counts;
    }

    public async Task<List<ObjectSummary>> ReadObjectsAsync(string kind, CancellationToken ct = default)
    {
        string sql = kind.ToLowerInvariant() switch
        {
            "tables" or "views" or "sequences" => $"""
                SELECT n.nspname, c.relname,
                       CASE c.relkind WHEN 'r' THEN 'TABLE' WHEN 'p' THEN 'PARTITIONED_TABLE'
                                      WHEN 'v' THEN 'VIEW'  WHEN 'm' THEN 'MATERIALIZED_VIEW'
                                      WHEN 'S' THEN 'SEQUENCE' END,
                       NULL::text
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ({RelKinds(kind)}) AND {UserSchemas}
                ORDER BY n.nspname, c.relname
                """,
            "procedures" or "functions" => $"""
                SELECT n.nspname, p.proname,
                       CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE'
                                      WHEN 'w' THEN 'WINDOW_FUNCTION' ELSE 'FUNCTION' END,
                       NULL::text
                FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE p.prokind {(kind.Equals("procedures", StringComparison.OrdinalIgnoreCase) ? "= 'p'" : "IN ('f','a','w')")}
                  AND {UserSchemas}
                ORDER BY n.nspname, p.proname
                """,
            "triggers" => $"""
                SELECT n.nspname, t.tgname, 'TRIGGER', c.relname
                FROM pg_trigger t
                JOIN pg_class c ON c.oid = t.tgrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE NOT t.tgisinternal AND {UserSchemas}
                ORDER BY n.nspname, t.tgname
                """,
            "types" => $"""
                SELECT n.nspname, t.typname,
                       CASE t.typtype WHEN 'c' THEN 'COMPOSITE_TYPE' WHEN 'd' THEN 'DOMAIN' ELSE 'ENUM' END,
                       NULL::text
                FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                WHERE t.typtype IN ('c','d','e') AND {UserSchemas}
                  AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind <> 'c')
                ORDER BY n.nspname, t.typname
                """,
            _ => throw new InvalidOperationException($"'{kind}' is not listable on PostgreSQL."),
        };

        var rows = new List<ObjectSummary>();
        await using var conn = await OpenAsync(ct);
        await using var cmd = Db.ReadOnly(Pg, conn, sql);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            rows.Add(new ObjectSummary
            {
                Schema = reader.GetString(0),
                Name = reader.GetString(1),
                TypeDesc = reader.IsDBNull(2) ? "OBJECT" : reader.GetString(2),
                Parent = reader.IsDBNull(3) ? null : reader.GetString(3),
                // PostgreSQL keeps no creation or modification time for an object.
                CreateDate = default,
                ModifyDate = default,
            });
        }
        return rows;
    }

    private static string RelKinds(string kind) => kind.ToLowerInvariant() switch
    {
        "tables" => "'r','p'",
        "views" => "'v','m'",
        _ => "'S'",
    };

    public async Task<TableShape?> ReadTableShapeAsync(string schema, string name, CancellationToken ct = default)
    {
        const string sql = """
            SELECT c.oid::int,
                   a.attname,
                   a.attnum,
                   format_type(a.atttypid, NULL) AS base_type,
                   CASE
                     WHEN a.atttypmod > 0 AND t.typname IN ('varchar','bpchar') THEN a.atttypmod - 4
                     WHEN t.typname IN ('text','bytea','json','jsonb','xml') THEN -1
                     ELSE 0
                   END AS max_length,
                   CASE WHEN t.typname = 'numeric' AND a.atttypmod > 0
                        THEN ((a.atttypmod - 4) >> 16) & 65535 ELSE 0 END AS precision,
                   CASE WHEN t.typname = 'numeric' AND a.atttypmod > 0
                        THEN (a.atttypmod - 4) & 65535 ELSE 0 END AS scale,
                   NOT a.attnotnull,
                   a.attidentity <> '' OR pg_get_serial_sequence(quote_ident(n.nspname)||'.'||quote_ident(c.relname), a.attname) IS NOT NULL,
                   a.attgenerated <> '',
                   pg_get_expr(ad.adbin, ad.adrelid),
                   (SELECT array_position(i.indkey::int[], a.attnum::int) + 1
                    FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary)
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            JOIN pg_type t ON t.oid = a.atttypid
            LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
            WHERE n.nspname = @schema AND c.relname = @name AND c.relkind IN ('r','p','v','m')
            ORDER BY a.attnum
            """;

        var columns = new List<ColumnSummary>();
        int oid = 0;
        await using (var conn = await OpenAsync(ct))
        {
            await using var cmd = Db.ReadOnly(Pg, conn, sql);
            cmd.With("@schema", schema);
            cmd.With("@name", name);
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                oid = reader.GetInt32(0);
                columns.Add(new ColumnSummary
                {
                    Name = reader.GetString(1),
                    ColumnId = reader.GetInt16(2),
                    TypeName = BaseType(reader.GetString(3)),
                    MaxLength = (short)Math.Clamp(reader.GetInt32(4), short.MinValue, short.MaxValue),
                    Precision = (byte)Math.Clamp(reader.GetInt32(5), 0, 255),
                    Scale = (byte)Math.Clamp(reader.GetInt32(6), 0, 255),
                    IsNullable = reader.GetBoolean(7),
                    IsIdentity = reader.GetBoolean(8),
                    IsComputed = reader.GetBoolean(9),
                    DefaultDefinition = reader.IsDBNull(10) ? null : reader.GetString(10),
                    // indkey is an int2vector, whose lower bound is 0 and stays 0 through the
                    // cast, so array_position returns 0 for the first key column. The UI shows the
                    // same 1-based ordinal SQL Server's key_ordinal gives, hence the + 1.
                    PrimaryKeyOrdinal = reader.IsDBNull(11) ? null : reader.GetInt32(11),
                });
            }
        }

        return columns.Count == 0
            ? null
            : new TableShape { ObjectId = oid, Schema = schema, Name = name, Columns = columns };
    }

    // format_type gives "character varying(50)"; the rest of the app keys off a bare type name,
    // and the length is carried separately in MaxLength.
    // format_type writes the SQL standard spelling ("character varying"); every screen in
    // this tool shows the short name. Shared with PgCatalogReader so the diagram and the table
    // page never name the same column's type two different ways.
    internal static string BaseType(string formatted)
    {
        int paren = formatted.IndexOf('(');
        string bare = (paren < 0 ? formatted : formatted[..paren]).Trim();
        return bare switch
        {
            "character varying" => "varchar",
            "character" => "char",
            "timestamp without time zone" => "timestamp",
            "timestamp with time zone" => "timestamptz",
            "time without time zone" => "time",
            "time with time zone" => "timetz",
            "double precision" => "float8",
            _ => bare,
        };
    }

    public async Task<TableFacts?> ReadTableFactsAsync(string schema, string name, CancellationToken ct = default)
    {
        const string ownerSql = """
            SELECT pg_get_userbyid(c.relowner)
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = @schema AND c.relname = @name
            """;
        const string indexSql = """
            SELECT i.relname,
                   x.indisunique, x.indisprimary,
                   pg_get_expr(x.indpred, x.indrelid),
                   (SELECT array_agg(pg_get_indexdef(x.indexrelid, k, true) ORDER BY k)
                    FROM generate_series(1, x.indnkeyatts) k),
                   (SELECT array_agg(pg_get_indexdef(x.indexrelid, k, true) ORDER BY k)
                    FROM generate_series(x.indnkeyatts + 1, x.indnatts) k),
                   am.amname,
                   EXISTS (SELECT 1 FROM pg_constraint cc WHERE cc.conindid = x.indexrelid AND cc.contype = 'u')
            FROM pg_index x
            JOIN pg_class i ON i.oid = x.indexrelid
            JOIN pg_class c ON c.oid = x.indrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_am am ON am.oid = i.relam
            WHERE n.nspname = @schema AND c.relname = @name
            ORDER BY x.indisprimary DESC, i.relname
            """;

        await using var conn = await OpenAsync(ct);

        string? owner = null;
        await using (var cmd = Db.ReadOnly(Pg, conn, ownerSql))
        {
            cmd.With("@schema", schema);
            cmd.With("@name", name);
            owner = (await cmd.ExecuteScalarAsync(ct)) as string;
        }

        if (owner is null)
        {
            return null;
        }

        var indexes = new List<IndexSummary>();
        await using (var cmd = Db.ReadOnly(Pg, conn, indexSql))
        {
            cmd.With("@schema", schema);
            cmd.With("@name", name);
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                var keys = reader.IsDBNull(4) ? [] : reader.GetFieldValue<string[]>(4);
                var included = reader.IsDBNull(5) ? [] : reader.GetFieldValue<string[]>(5);
                indexes.Add(new IndexSummary
                {
                    Name = reader.GetString(0),
                    // PostgreSQL has no clustered index; the access method is the closer fact and
                    // is what a reader actually wants to know (btree, gin, brin...).
                    TypeDesc = reader.IsDBNull(6) ? "INDEX" : reader.GetString(6).ToUpperInvariant(),
                    IsUnique = reader.GetBoolean(1),
                    IsPrimaryKey = reader.GetBoolean(2),
                    IsUniqueConstraint = reader.GetBoolean(7),
                    Filter = reader.IsDBNull(3) ? null : reader.GetString(3),
                    KeyColumns = [.. keys.Select(k => new IndexColumn
                    {
                        Name = k.Replace(" DESC", string.Empty).Trim('"'),
                        Descending = k.EndsWith(" DESC", StringComparison.Ordinal),
                    })],
                    IncludedColumns = [.. included.Select(c => c.Trim('"'))],
                });
            }
        }

        return new TableFacts { CreateDate = null, ModifyDate = null, Owner = owner, Indexes = indexes };
    }

    public async Task<ObjectDetail?> ReadModuleDefinitionAsync(string schema, string name, CancellationToken ct = default)
    {
        // Every kind the dashboard can list, because every badge on that page is clickable and a
        // 404 on a sequence someone can see is just a broken link.
        //
        // PostgreSQL stores a view and a routine as text it will hand back (pg_get_viewdef,
        // pg_get_functiondef, pg_get_triggerdef); a sequence and a type are stored as parts, so
        // the CREATE is composed here — the same split, and the same meaning of Generated, as the
        // SQL Server side, where modules answer from sys.sql_modules and the rest are scripted.
        //
        // Npgsql has no MARS, so these run one after another on the one connection and stop at
        // the first hit. Names do not collide across these catalogs in practice; when they do,
        // this order decides.
        await using var conn = await OpenAsync(ct);

        return await ReadViewAsync(conn, schema, name, ct)
            ?? await ReadRoutineAsync(conn, schema, name, ct)
            ?? await ReadTriggerAsync(conn, schema, name, ct)
            ?? await ReadSequenceAsync(conn, schema, name, ct)
            ?? await ReadTypeAsync(conn, schema, name, ct);
    }

    private static async Task<ObjectDetail?> ReadViewAsync(DbConnection conn, string schema, string name, CancellationToken ct)
    {
        const string sql = """
            SELECT CASE c.relkind WHEN 'm' THEN 'MATERIALIZED_VIEW' ELSE 'VIEW' END,
                   pg_get_viewdef(c.oid, true)
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = @schema AND c.relname = @name AND c.relkind IN ('v', 'm')
            """;

        var row = await OneAsync(conn, sql, schema, name, ct);
        if (row is null)
        {
            return null;
        }

        // pg_get_viewdef returns the SELECT alone; the CREATE around it is reconstructed so the
        // pane shows something runnable, which is what Generated records.
        string keyword = row[0] == "MATERIALIZED_VIEW" ? "CREATE MATERIALIZED VIEW" : "CREATE OR REPLACE VIEW";
        return Detail(schema, name, row[0], $"{keyword} {PgIdentifier.Qualify(schema, name)} AS\n{row[1]}", generated: true);
    }

    private static async Task<ObjectDetail?> ReadRoutineAsync(DbConnection conn, string schema, string name, CancellationToken ct)
    {
        // Overloads share a name. All of them are shown, separated, rather than picking one and
        // quietly hiding the rest.
        const string sql = """
            SELECT CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE'
                                  WHEN 'w' THEN 'WINDOW_FUNCTION' ELSE 'FUNCTION' END,
                   CASE WHEN p.prokind IN ('f', 'p') THEN pg_get_functiondef(p.oid)
                        ELSE format('-- %s %s(%s)', p.prokind, p.proname, pg_get_function_arguments(p.oid)) END
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = @schema AND p.proname = @name AND p.prokind IN ('f', 'p', 'a', 'w')
            ORDER BY p.oid
            """;

        var rows = await ManyAsync(conn, sql, schema, name, ct);
        if (rows.Count == 0)
        {
            return null;
        }

        return Detail(schema, name, rows[0][0], string.Join("\n\n", rows.Select(r => r[1])), generated: false);
    }

    private static async Task<ObjectDetail?> ReadTriggerAsync(DbConnection conn, string schema, string name, CancellationToken ct)
    {
        // A trigger is named within its TABLE, not within the schema, so the name alone can match
        // more than one. The schema narrows it; beyond that the first is shown, and the table it
        // belongs to is in the statement.
        const string sql = """
            SELECT 'TRIGGER', pg_get_triggerdef(t.oid, true)
            FROM pg_trigger t
            JOIN pg_class c ON c.oid = t.tgrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = @schema AND t.tgname = @name AND NOT t.tgisinternal
            ORDER BY c.relname
            """;

        var row = await OneAsync(conn, sql, schema, name, ct);
        return row is null ? null : Detail(schema, name, "TRIGGER", row[1] + ";", generated: false);
    }

    private static async Task<ObjectDetail?> ReadSequenceAsync(DbConnection conn, string schema, string name, CancellationToken ct)
    {
        const string sql = """
            SELECT 'SEQUENCE', format(
                E'CREATE SEQUENCE %I.%I\n    AS %s\n    START WITH %s\n    INCREMENT BY %s\n    MINVALUE %s\n    MAXVALUE %s\n    CACHE %s%s;',
                s.schemaname, s.sequencename, s.data_type, s.start_value, s.increment_by,
                s.min_value, s.max_value, s.cache_size, CASE WHEN s.cycle THEN E'\n    CYCLE' ELSE '' END)
            FROM pg_sequences s
            WHERE s.schemaname = @schema AND s.sequencename = @name
            """;

        var row = await OneAsync(conn, sql, schema, name, ct);
        return row is null ? null : Detail(schema, name, "SEQUENCE", row[1], generated: true);
    }

    private static async Task<ObjectDetail?> ReadTypeAsync(DbConnection conn, string schema, string name, CancellationToken ct)
    {
        // Enum, domain and composite are three different statements built from three different
        // catalogs, so the composition happens in SQL where the parts already are.
        const string sql = """
            SELECT CASE t.typtype WHEN 'e' THEN 'ENUM' WHEN 'd' THEN 'DOMAIN' ELSE 'COMPOSITE_TYPE' END,
                   CASE t.typtype
                       WHEN 'e' THEN format(E'CREATE TYPE %I.%I AS ENUM (\n    %s\n);', n.nspname, t.typname,
                           (SELECT string_agg(quote_literal(e.enumlabel), E',\n    ' ORDER BY e.enumsortorder)
                            FROM pg_enum e WHERE e.enumtypid = t.oid))
                       WHEN 'd' THEN format('CREATE DOMAIN %I.%I AS %s%s%s%s;', n.nspname, t.typname,
                           format_type(t.typbasetype, t.typtypmod),
                           CASE WHEN t.typdefault IS NULL THEN '' ELSE ' DEFAULT ' || t.typdefault END,
                           CASE WHEN t.typnotnull THEN ' NOT NULL' ELSE '' END,
                           COALESCE((SELECT string_agg(' ' || pg_get_constraintdef(c.oid), '')
                                     FROM pg_constraint c WHERE c.contypid = t.oid), ''))
                       ELSE format(E'CREATE TYPE %I.%I AS (\n    %s\n);', n.nspname, t.typname,
                           (SELECT string_agg(format('%I %s', a.attname, format_type(a.atttypid, a.atttypmod)),
                                              E',\n    ' ORDER BY a.attnum)
                            FROM pg_attribute a
                            WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped))
                   END
            FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = @schema AND t.typname = @name AND t.typtype IN ('c', 'd', 'e')
            """;

        var row = await OneAsync(conn, sql, schema, name, ct);
        return row is null ? null : Detail(schema, name, row[0], row[1], generated: true);
    }

    private static async Task<List<string[]>> ManyAsync(
        DbConnection conn, string sql, string schema, string name, CancellationToken ct)
    {
        var rows = new List<string[]>();
        await using var cmd = Db.ReadOnly(Pg, conn, sql);
        cmd.With("@schema", schema);
        cmd.With("@name", name);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            rows.Add([reader.GetString(0), reader.IsDBNull(1) ? string.Empty : reader.GetString(1)]);
        }
        return rows;
    }

    private static async Task<string[]?> OneAsync(
        DbConnection conn, string sql, string schema, string name, CancellationToken ct) =>
        (await ManyAsync(conn, sql, schema, name, ct)).FirstOrDefault();

    private static ObjectDetail Detail(string schema, string name, string typeDesc, string definition, bool generated) => new()
    {
        Schema = schema,
        Name = name,
        TypeDesc = typeDesc,
        Definition = definition,
        Generated = generated,
        // These catalogs carry no create or modify timestamp.
        CreateDate = default,
        ModifyDate = default,
    };

    public string BuildPreviewSql(TableShape shape, int top, string? where)
    {
        var parts = shape.Columns.Select(Project).ToList();
        string whereClause = string.IsNullOrWhiteSpace(where) ? string.Empty : $"\nWHERE ({where})";
        return $"SELECT\n    {string.Join(",\n    ", parts)}\nFROM {PgIdentifier.Qualify(shape.Schema, shape.Name)}"
             + $"{whereClause}\nLIMIT {top};";
    }

    // Long text and binary are cut down in the database rather than on the wire, the same as the
    // SQL Server preview does.
    private static string Project(ColumnSummary column)
    {
        string quoted = PgIdentifier.Quote(column.Name);
        string t = column.TypeName.ToLowerInvariant();

        if (t is "bytea")
        {
            return $"('\\x' || encode(substring({quoted} FROM 1 FOR {BinaryBytes}), 'hex')) AS {quoted}";
        }
        if (t is "text" or "json" or "jsonb" or "xml" || column.MaxLength == -1 || column.MaxLength > TextLimit)
        {
            return $"left({quoted}::text, {TextLimit}) AS {quoted}";
        }
        return quoted;
    }

    public async Task<PreviewResult> PreviewAsync(
        TableShape shape, int top, string? where, int timeoutSeconds = 30, CancellationToken ct = default)
    {
        string sql = BuildPreviewSql(shape, top, where);
        if (shape.Columns.Count == 0)
        {
            return new PreviewResult { Columns = [], Rows = [], Sql = string.Empty, ElapsedMs = 0, Messages = [] };
        }

        var rows = new List<object?[]>();
        var watch = Stopwatch.StartNew();
        await using (var conn = await OpenAsync(ct))
        {
            await using var cmd = Db.ReadOnly(Pg, conn, sql);
            cmd.CommandTimeout = timeoutSeconds;
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                var values = new object?[reader.FieldCount];
                for (int i = 0; i < reader.FieldCount; i++)
                {
                    values[i] = DataExplorer.FormatValue(reader.IsDBNull(i) ? null : reader.GetValue(i));
                }
                rows.Add(values);
            }
        }
        watch.Stop();

        bool[] truncated = new bool[shape.Columns.Count];
        for (int i = 0; i < shape.Columns.Count && i < rows.FirstOrDefault()?.Length; i++)
        {
            truncated[i] = rows.Any(r => r[i] is string text && text.Length >= TextLimit);
        }

        return new PreviewResult
        {
            Columns = [.. shape.Columns.Select((c, i) => new PreviewColumn { Column = c, Truncated = truncated[i] })],
            Rows = rows,
            Sql = sql,
            ElapsedMs = watch.ElapsedMilliseconds,
            Messages = [],
        };
    }

    public async Task<QueryResult> RunQueryAsync(
        string sql, int maxRows = 1000, int timeoutSeconds = 30, CancellationToken ct = default)
    {
        var rows = new List<object?[]>();
        var columns = new List<QueryColumn>();
        bool capped = false;
        var watch = Stopwatch.StartNew();

        await using (var conn = await OpenAsync(ct))
        {
            await using var cmd = Db.ReadOnly(Pg, conn, sql);
            cmd.CommandTimeout = timeoutSeconds;
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            for (int i = 0; i < reader.FieldCount; i++)
            {
                columns.Add(new QueryColumn { Name = reader.GetName(i), TypeName = reader.GetDataTypeName(i) });
            }
            while (await reader.ReadAsync(ct))
            {
                if (rows.Count >= maxRows)
                {
                    capped = true;
                    break;
                }
                var values = new object?[reader.FieldCount];
                for (int i = 0; i < reader.FieldCount; i++)
                {
                    values[i] = DataExplorer.FormatValue(reader.IsDBNull(i) ? null : reader.GetValue(i));
                }
                rows.Add(values);
            }
        }
        watch.Stop();

        return new QueryResult
        {
            Columns = columns,
            Rows = rows,
            Sql = sql,
            ElapsedMs = watch.ElapsedMilliseconds,
            Messages = [],
            Capped = capped,
        };
    }

    public async Task<long> CountAsync(
        string schema, string table, string? where, int timeoutSeconds = 30, CancellationToken ct = default)
    {
        string whereClause = string.IsNullOrWhiteSpace(where) ? string.Empty : $"\nWHERE ({where})";
        string sql = $"SELECT count(*) FROM {PgIdentifier.Qualify(schema, table)}{whereClause};";

        await using var conn = await OpenAsync(ct);
        await using var cmd = Db.ReadOnly(Pg, conn, sql);
        cmd.CommandTimeout = timeoutSeconds;
        object? value = await cmd.ExecuteScalarAsync(ct);
        return value is null or DBNull ? 0 : Convert.ToInt64(value, CultureInfo.InvariantCulture);
    }
}
