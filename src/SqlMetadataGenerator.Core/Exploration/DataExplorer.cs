using System.Diagnostics;
using System.Globalization;
using Microsoft.Data.SqlClient;

namespace SqlMetadataGenerator.Exploration;

// Database-level exploration: table statistics, row preview and WHERE counts.
//
// DMVs are NOT USED for size and row information. On SQL Server 2022 sys.dm_db_partition_stats
// requires VIEW DATABASE PERFORMANCE STATE, which a read-only user does not have.
// sys.partitions + sys.allocation_units give the same numbers and need only metadata
// visibility — the normal scenario for this tool is a low-privilege user.
public sealed class DataExplorer(string connectionString)
{
    // How many characters a text column is truncated to in the preview. The projection is written
    // against this limit, and whether truncation happened is read off the same limit.
    internal const int TextLimit = 256;

    private readonly string _connectionString = connectionString;

    private async Task<SqlConnection> OpenAsync(CancellationToken ct)
    {
        var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        return conn;
    }

    // The single query behind the treemap and the table grid. No scan; the numbers are approximate.
    public async Task<List<TableStats>> ReadTableStatsAsync(CancellationToken ct = default)
    {
        // CAREFUL: the row count and the size come from SEPARATE sub-queries.
        // Joining sys.partitions straight to sys.allocation_units multiplies the partition row by
        // the number of allocation units (IN_ROW + LOB + ROW_OVERFLOW), so SUM(p.rows) is
        // multiplied too — a table with a LOB column reported three times its real row count.
        // The allocation join has two branches: type 1/3 match on hobt_id, type 2 on partition_id.
        const string sql = """
            SELECT
                s.name,
                t.name,
                ISNULL(r.row_count, 0),
                ISNULL(a.reserved_kb, 0),
                ISNULL(a.used_kb, 0)
            FROM sys.tables t
            JOIN sys.schemas s ON t.schema_id = s.schema_id
            LEFT JOIN (
                SELECT p.object_id, SUM(p.rows) AS row_count
                FROM sys.partitions p
                WHERE p.index_id IN (0, 1)
                GROUP BY p.object_id
            ) r ON r.object_id = t.object_id
            LEFT JOIN (
                SELECT p.object_id,
                       SUM(au.total_pages) * 8 AS reserved_kb,
                       SUM(au.used_pages) * 8 AS used_kb
                FROM sys.partitions p
                JOIN sys.allocation_units au
                       ON (au.type IN (1, 3) AND au.container_id = p.hobt_id)
                       OR (au.type = 2 AND au.container_id = p.partition_id)
                GROUP BY p.object_id
            ) a ON a.object_id = t.object_id
            WHERE t.is_ms_shipped = 0 AND t.type = 'U'
            ORDER BY s.name, t.name;
            """;

        var list = new List<TableStats>();
        await using var conn = await OpenAsync(ct);
        await using var cmd = ReadOnlyCommand.Create(conn, sql);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            list.Add(new TableStats
            {
                Schema = reader.GetString(0),
                Name = reader.GetString(1),
                RowCount = reader.GetInt64(2),
                ReservedKb = reader.GetInt64(3),
                UsedKb = reader.GetInt64(4),
            });
        }

        return list;
    }

    // The counters on the database dashboard. The type names match the ObjectFilter.ValidTypes vocabulary.
    public async Task<Dictionary<string, int>> ReadObjectCountsAsync(CancellationToken ct = default)
    {
        const string sql = """
            SELECT kind, COUNT(*) FROM (
                SELECT CASE o.type
                    WHEN 'U'  THEN 'tables'
                    WHEN 'V'  THEN 'views'
                    WHEN 'P'  THEN 'procedures'
                    WHEN 'TR' THEN 'triggers'
                    WHEN 'SN' THEN 'synonyms'
                    WHEN 'SO' THEN 'sequences'
                    WHEN 'TT' THEN 'types'
                    WHEN 'FN' THEN 'functions'
                    WHEN 'IF' THEN 'functions'
                    WHEN 'TF' THEN 'functions'
                    WHEN 'AF' THEN 'functions'
                END AS kind
                FROM sys.objects o
                WHERE o.is_ms_shipped = 0
            ) x
            WHERE kind IS NOT NULL
            GROUP BY kind
            UNION ALL
            SELECT 'schemas', COUNT(*) FROM sys.schemas WHERE schema_id BETWEEN 5 AND 16383;
            """;

        var counts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        await using var conn = await OpenAsync(ct);
        await using var cmd = ReadOnlyCommand.Create(conn, sql);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            counts[reader.GetString(0)] = reader.GetInt32(1);
        }

        return counts;
    }

    // Validates the table and reads ALL of its column metadata in ONE round trip.
    // There used to be three separate queries (existence check, preview columns, detail
    // columns) and two endpoints ran them independently; against a server in Germany
    // every round trip meant ~60 ms of pure latency.
    //
    // The canonical names come back from the catalog and every later SQL statement is built
    // from those, never from the text the user typed — which closes the injection surface.
    public async Task<TableShape?> ReadTableShapeAsync(
        string schema, string name, CancellationToken ct = default)
    {
        const string sql = """
            SELECT
                s.name, t.name, t.object_id,
                c.name, c.column_id, ty.name, c.max_length, c.precision, c.scale,
                c.is_nullable, c.is_identity,
                CASE WHEN cc.object_id IS NULL THEN 0 ELSE 1 END AS is_computed,
                dc.definition,
                pk.key_ordinal
            FROM sys.tables t
            JOIN sys.schemas s ON t.schema_id = s.schema_id
            JOIN sys.columns c ON c.object_id = t.object_id
            JOIN sys.types ty ON c.user_type_id = ty.user_type_id
            LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
            LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
            LEFT JOIN (
                SELECT ic.object_id, ic.column_id, ic.key_ordinal
                FROM sys.indexes i
                JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                WHERE i.is_primary_key = 1
            ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
            WHERE s.name = @schema AND t.name = @name AND t.is_ms_shipped = 0 AND t.type = 'U'
            ORDER BY c.column_id;
            """;

        string? canonicalSchema = null;
        string? canonicalName = null;
        int objectId = 0;
        var columns = new List<ColumnSummary>();

        await using var conn = await OpenAsync(ct);
        await using var cmd = ReadOnlyCommand.Create(conn, sql);
        cmd.Parameters.AddWithValue("@schema", schema);
        cmd.Parameters.AddWithValue("@name", name);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            canonicalSchema ??= reader.GetString(0);
            canonicalName ??= reader.GetString(1);
            objectId = reader.GetInt32(2);
            columns.Add(new ColumnSummary
            {
                Name = reader.GetString(3),
                ColumnId = reader.GetInt32(4),
                TypeName = reader.GetString(5),
                MaxLength = reader.GetInt16(6),
                Precision = reader.GetByte(7),
                Scale = reader.GetByte(8),
                IsNullable = reader.GetBoolean(9),
                IsIdentity = reader.GetBoolean(10),
                IsComputed = reader.GetInt32(11) == 1,
                DefaultDefinition = reader.IsDBNull(12) ? null : reader.GetString(12),
                PrimaryKeyOrdinal = reader.IsDBNull(13) ? null : reader.GetByte(13),
            });
        }

        if (canonicalSchema is null || canonicalName is null)
        {
            return null;
        }

        return new TableShape
        {
            ObjectId = objectId,
            Schema = canonicalSchema,
            Name = canonicalName,
            Columns = columns,
        };
    }

    // A TOP N row preview. Large text and binary columns are shortened ON THE SERVER;
    // otherwise a single row could carry megabytes (e.g. an nvarchar(max) JSON payload).
    // The column metadata is supplied by the caller: reading the same information a second
    // time cost an extra round trip.
    public async Task<PreviewResult> PreviewAsync(
        TableShape shape, int top, string? where,
        int timeoutSeconds = 30, CancellationToken ct = default)
    {
        var columns = shape.Columns.Select(c => BuildPlan(c.Name, c.TypeName, c.MaxLength)).ToList();
        if (columns.Count == 0)
        {
            return new PreviewResult { Columns = [], Rows = [], Sql = string.Empty, ElapsedMs = 0, Messages = [] };
        }

        string displaySql = ComposeSql(columns, shape.Schema, shape.Name, top, where);

        // The isolation level is prepended by ReadOnlyCommand; it is not part of the text
        // shown to the user.
        string sql = displaySql;

        var rows = new List<object?[]>();
        var messages = new List<string>();
        await using var conn = await OpenAsync(ct);

        // PRINT output and warnings are not errors and never arrive as exceptions; they are
        // collected and shown to the user (the equivalent of the Messages tab in SSMS).
        void OnInfo(object _, SqlInfoMessageEventArgs e)
        {
            foreach (SqlError error in e.Errors)
            {
                messages.Add(error.Message);
            }
        }

        conn.InfoMessage += OnInfo;
        var stopwatch = Stopwatch.StartNew();
        try
        {
            await using var cmd = ReadOnlyCommand.Create(conn, sql);
            cmd.CommandTimeout = timeoutSeconds;
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                var values = new object?[reader.FieldCount];
                for (int i = 0; i < reader.FieldCount; i++)
                {
                    values[i] = FormatValue(reader.IsDBNull(i) ? null : reader.GetValue(i));
                }
                rows.Add(values);
            }
        }
        finally
        {
            stopwatch.Stop();
            conn.InfoMessage -= OnInfo;
        }

        // The badge must mean "was truncated", not "could be truncated". On a column declared
        // nvarchar(max) whose values are short the projection is still wrapped in LEFT, yet not
        // a single character was cut; a warning there is noise.
        // When a value reaches the limit, the column really was truncated.
        var actuallyTruncated = new bool[columns.Count];
        for (int i = 0; i < columns.Count; i++)
        {
            actuallyTruncated[i] = columns[i].Truncated
                && rows.Any(r => r[i] is string text && text.Length >= TextLimit);
        }

        return new PreviewResult
        {
            Columns = shape.Columns.Select((c, i) => new PreviewColumn
            {
                Column = c,
                Truncated = actuallyTruncated[i],
            }).ToList(),
            Rows = rows,
            Sql = displaySql,
            ElapsedMs = stopwatch.ElapsedMilliseconds,
            Messages = messages,
        };
    }

    // Builds the text of the preview query. The text depends only on the column metadata,
    // never on the query RUNNING — which is why the UI can show it without waiting for the result.
    public static string BuildPreviewSql(TableShape shape, int top, string? where)
    {
        var columns = shape.Columns.Select(c => BuildPlan(c.Name, c.TypeName, c.MaxLength)).ToList();
        return columns.Count == 0 ? string.Empty : ComposeSql(columns, shape.Schema, shape.Name, top, where);
    }

    // top is an int the caller has already bounded; it is written inline instead of as a parameter.
    // That way the query shown to the user and the query that runs are the same text —
    // no showing "TOP (@top)" while "TOP 20" executes.
    private static string ComposeSql(
        List<PreviewColumnPlan> columns, string schema, string table, int top, string? where)
    {
        string projection = string.Join(",\n       ", columns.Select(c => c.Projection));
        string qualified = $"{SqlIdentifier.Quote(schema)}.{SqlIdentifier.Quote(table)}";
        string whereClause = string.IsNullOrWhiteSpace(where) ? string.Empty : $"\nWHERE ({where})";

        return $"""
            SELECT TOP {top}
                   {projection}
            FROM {qualified}{whereClause};
            """;
    }

    // The number of rows matching the WHERE predicate. It can scan on a large table, so the
    // caller must always offer a timeout and a way to cancel.
    public async Task<long> CountAsync(
        string schema, string table, string? where,
        int timeoutSeconds = 30, CancellationToken ct = default)
    {
        string qualified = $"{SqlIdentifier.Quote(schema)}.{SqlIdentifier.Quote(table)}";
        string whereClause = string.IsNullOrWhiteSpace(where) ? string.Empty : $"\nWHERE ({where})";

        string sql = $"SELECT COUNT_BIG(*) FROM {qualified}{whereClause};";

        await using var conn = await OpenAsync(ct);
        await using var cmd = ReadOnlyCommand.Create(conn, sql);
        cmd.CommandTimeout = timeoutSeconds;
        var result = await cmd.ExecuteScalarAsync(ct);
        return result is null or DBNull ? 0 : Convert.ToInt64(result, CultureInfo.InvariantCulture);
    }


    internal sealed record PreviewColumnPlan(string Name, string TypeName, bool Truncated, string Projection);


    // The per-column truncation strategy used in the preview.
    internal static PreviewColumnPlan BuildPlan(string name, string typeName, short maxLength)
    {
        const int TextChars = TextLimit;
        const int BinaryBytes = 64;

        // Identifiers are bracketed only where that is necessary (SqlIdentifier.Quote).
        // The alias is likewise written only when the expression is wrapped: on a plain column
        // there is nothing to be gained from writing "Id AS Id".
        string quoted = SqlIdentifier.Quote(name);
        string alias = $" AS {quoted}";
        string t = typeName.ToLowerInvariant();

        // max_length: in bytes for text types (-1 = max), twice the character count for nvarchar.
        bool longText = maxLength == -1 || maxLength > TextChars * 2;
        bool longBinary = maxLength == -1 || maxLength > BinaryBytes;

        switch (t)
        {
            case "text" or "ntext" or "xml" or "sql_variant":
                return new PreviewColumnPlan(name, typeName, true,
                    $"LEFT(CONVERT(nvarchar(max), {quoted}), {TextChars}){alias}");

            case "varchar" or "nvarchar" or "char" or "nchar" when longText:
                return new PreviewColumnPlan(name, typeName, true,
                    $"LEFT(CONVERT(nvarchar(max), {quoted}), {TextChars}){alias}");

            case "binary" or "varbinary" or "image" when longBinary:
                return new PreviewColumnPlan(name, typeName, true,
                    $"CONVERT(varchar({BinaryBytes * 2 + 2}), CONVERT(varbinary({BinaryBytes}), {quoted}), 1){alias}");

            // CLR types cannot be cast to nvarchar; they fall back to the hex representation.
            case "geography" or "geometry" or "hierarchyid":
                return new PreviewColumnPlan(name, typeName, true,
                    $"CONVERT(varchar({BinaryBytes * 2 + 2}), CONVERT(varbinary({BinaryBytes}), CONVERT(varbinary(max), {quoted})), 1){alias}");

            default:
                // No wrapping: the column itself already carries the result column name.
                return new PreviewColumnPlan(name, typeName, false, quoted);
        }
    }

    // Value conversion that is safe for JSON. bigint and decimal can exceed JavaScript's safe
    // integer range, so they are turned into text rather than losing precision.
    internal static object? FormatValue(object? value)
    {
        return value switch
        {
            null => null,
            bool b => b,
            byte or short or int => Convert.ToInt32(value, CultureInfo.InvariantCulture),
            long l => l is >= -9007199254740991 and <= 9007199254740991 ? l : l.ToString(CultureInfo.InvariantCulture),
            decimal d => d.ToString(CultureInfo.InvariantCulture),
            float or double => Convert.ToDouble(value, CultureInfo.InvariantCulture),
            DateTime dt => dt.ToString("o", CultureInfo.InvariantCulture),
            DateTimeOffset dto => dto.ToString("o", CultureInfo.InvariantCulture),
            TimeSpan ts => ts.ToString(),
            Guid g => g.ToString(),
            byte[] bytes => "0x" + Convert.ToHexString(bytes),
            string s => s,
            _ => value.ToString(),
        };
    }
}
