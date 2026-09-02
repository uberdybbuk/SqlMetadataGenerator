using System.Diagnostics;
using System.Globalization;
using Microsoft.Data.SqlClient;

namespace SqlMetadataGenerator.Exploration;

// Veritabanı seviyesi keşif: tablo istatistikleri, satır önizleme ve WHERE sayımı.
//
// Boyut/satır bilgisi için DMV KULLANILMAZ. sys.dm_db_partition_stats, SQL Server 2022'de
// VIEW DATABASE PERFORMANCE STATE izni ister ve salt-okunur bir kullanıcıda yoktur.
// sys.partitions + sys.allocation_units aynı sayıları verir ve yalnızca metadata
// görünürlüğü gerektirir — bu aracın normal senaryosu az yetkili kullanıcıdır.
public sealed class DataExplorer(string connectionString)
{
    // Önizlemede metin kolonlarının kesildiği karakter sayısı. Projeksiyon bu
    // sınırla yazılır, kesilip kesilmediği de aynı sınırla anlaşılır.
    internal const int TextLimit = 256;

    private readonly string _connectionString = connectionString;

    private async Task<SqlConnection> OpenAsync(CancellationToken ct)
    {
        var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        return conn;
    }

    // Treemap ve tablo grid'ini besleyen tek sorgu. Tarama yok; sayılar yaklaşıktır.
    public async Task<List<TableStats>> ReadTableStatsAsync(CancellationToken ct = default)
    {
        // DİKKAT: satır sayısı ve boyut AYRI alt sorgulardan gelir.
        // sys.partitions ile sys.allocation_units doğrudan join edilirse partition satırı
        // allocation unit sayısınca çoğalır (IN_ROW + LOB + ROW_OVERFLOW) ve SUM(p.rows)
        // katlanır — LOB kolonu olan tabloda satır sayısı 3 katına çıkıyordu.
        // allocation join'i iki dallı: type 1/3 hobt_id ile, type 2 partition_id ile eşleşir.
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

    // DB dashboard'undaki sayaçlar. Tip adları ObjectFilter.ValidTypes sözlüğüyle aynı.
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

    // Tabloyu katalogdan doğrular ve KANONİK adları döner. Sonraki SQL'ler bu adlardan
    // kurulur, kullanıcının yazdığı metinden değil — enjeksiyon yüzeyi böylece kapanır.
    public async Task<(int ObjectId, string Schema, string Name)?> ResolveTableAsync(
        string schema, string name, CancellationToken ct = default)
    {
        const string sql = """
            SELECT t.object_id, s.name, t.name
            FROM sys.tables t
            JOIN sys.schemas s ON t.schema_id = s.schema_id
            WHERE s.name = @schema AND t.name = @name AND t.is_ms_shipped = 0 AND t.type = 'U';
            """;

        await using var conn = await OpenAsync(ct);
        await using var cmd = ReadOnlyCommand.Create(conn, sql);
        cmd.Parameters.AddWithValue("@schema", schema);
        cmd.Parameters.AddWithValue("@name", name);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct))
        {
            return null;
        }

        return (reader.GetInt32(0), reader.GetString(1), reader.GetString(2));
    }

    // TOP N satır önizlemesi. Büyük metin/binary kolonlar SUNUCU TARAFINDA kısaltılır;
    // aksi hâlde tek satır megabaytlarca veri taşıyabilir (ör. nvarchar(max) JSON payload).
    public async Task<PreviewResult> PreviewAsync(
        int objectId, string schema, string table, int top, string? where,
        int timeoutSeconds = 30, CancellationToken ct = default)
    {
        var columns = await ReadPreviewColumnsAsync(objectId, ct);
        if (columns.Count == 0)
        {
            return new PreviewResult { Columns = [], Rows = [], Sql = string.Empty, ElapsedMs = 0, Messages = [] };
        }

        string displaySql = ComposeSql(columns, schema, table, top, where);

        // Yalıtım seviyesi ReadOnlyCommand tarafından eklenir; kullanıcıya gösterilen
        // metnin parçası değildir.
        string sql = displaySql;

        var rows = new List<object?[]>();
        var messages = new List<string>();
        await using var conn = await OpenAsync(ct);

        // PRINT ve uyarılar hata değildir, istisna olarak gelmezler; ayrıca toplanıp
        // kullanıcıya gösterilir (SSMS'teki Messages sekmesinin karşılığı).
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

        // Damga "kısaltılabilir" değil "kısaltıldı" anlamına gelmeli. nvarchar(max)
        // tanımlı ama değerleri kısa bir kolonda projeksiyon LEFT ile sarmalanır,
        // yine de tek bir karakter bile kesilmemiştir; orada uyarı göstermek gürültü.
        // Sınıra dayanan bir değer varsa kolon gerçekten kısaltılmıştır.
        var actuallyTruncated = new bool[columns.Count];
        for (int i = 0; i < columns.Count; i++)
        {
            actuallyTruncated[i] = columns[i].Truncated
                && rows.Any(r => r[i] is string text && text.Length >= TextLimit);
        }

        return new PreviewResult
        {
            Columns = columns.Select((c, i) => new PreviewColumn
            {
                Name = c.Name,
                TypeName = c.TypeName,
                Truncated = actuallyTruncated[i],
            }).ToList(),
            Rows = rows,
            Sql = displaySql,
            ElapsedMs = stopwatch.ElapsedMilliseconds,
            Messages = messages,
        };
    }

    // Önizleme sorgusunun metnini üretir. Metin yalnızca kolon metadatasına bağlıdır,
    // sorgunun ÇALIŞMASINA değil — bu yüzden arayüz onu sonucu beklemeden gösterebilir.
    public async Task<string> BuildPreviewSqlAsync(
        int objectId, string schema, string table, int top, string? where, CancellationToken ct = default)
    {
        var columns = await ReadPreviewColumnsAsync(objectId, ct);
        return columns.Count == 0 ? string.Empty : ComposeSql(columns, schema, table, top, where);
    }

    // top çağıran tarafta sınırlanmış bir int; parametre yerine doğrudan yazılır.
    // Böylece kullanıcıya gösterilen sorgu ile çalışan sorgu aynı metin olur —
    // "TOP (@top)" gösterip "TOP 20" çalıştırmak gibi bir ayrım kalmaz.
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

    // WHERE koşuluna uyan satır sayısı. Büyük tablolarda tarama yapabilir; çağıran
    // taraf mutlaka timeout ve iptal imkânı sunmalı.
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

    // Tablo detay sayfası için kolon listesi (PK üyeliği dahil).
    public async Task<List<ColumnSummary>> ReadTableColumnsAsync(int objectId, CancellationToken ct = default)
    {
        const string sql = """
            SELECT
                c.name, c.column_id, ty.name, c.max_length, c.precision, c.scale,
                c.is_nullable, c.is_identity,
                CASE WHEN cc.object_id IS NULL THEN 0 ELSE 1 END AS is_computed,
                dc.definition,
                pk.key_ordinal
            FROM sys.columns c
            JOIN sys.types ty ON c.user_type_id = ty.user_type_id
            LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
            LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
            LEFT JOIN (
                SELECT ic.object_id, ic.column_id, ic.key_ordinal
                FROM sys.indexes i
                JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                WHERE i.is_primary_key = 1
            ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
            WHERE c.object_id = @objectId
            ORDER BY c.column_id;
            """;

        var list = new List<ColumnSummary>();
        await using var conn = await OpenAsync(ct);
        await using var cmd = ReadOnlyCommand.Create(conn, sql);
        cmd.Parameters.AddWithValue("@objectId", objectId);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            list.Add(new ColumnSummary
            {
                Name = reader.GetString(0),
                ColumnId = reader.GetInt32(1),
                TypeName = reader.GetString(2),
                MaxLength = reader.GetInt16(3),
                Precision = reader.GetByte(4),
                Scale = reader.GetByte(5),
                IsNullable = reader.GetBoolean(6),
                IsIdentity = reader.GetBoolean(7),
                IsComputed = reader.GetInt32(8) == 1,
                DefaultDefinition = reader.IsDBNull(9) ? null : reader.GetString(9),
                PrimaryKeyOrdinal = reader.IsDBNull(10) ? null : reader.GetByte(10),
            });
        }

        return list;
    }

    internal sealed record PreviewColumnPlan(string Name, string TypeName, bool Truncated, string Projection);

    private async Task<List<PreviewColumnPlan>> ReadPreviewColumnsAsync(int objectId, CancellationToken ct)
    {
        const string sql = """
            SELECT c.name, ty.name, c.max_length
            FROM sys.columns c
            JOIN sys.types ty ON c.user_type_id = ty.user_type_id
            WHERE c.object_id = @objectId
            ORDER BY c.column_id;
            """;

        var plans = new List<PreviewColumnPlan>();
        await using var conn = await OpenAsync(ct);
        await using var cmd = ReadOnlyCommand.Create(conn, sql);
        cmd.Parameters.AddWithValue("@objectId", objectId);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            plans.Add(BuildPlan(reader.GetString(0), reader.GetString(1), reader.GetInt16(2)));
        }

        return plans;
    }

    // Önizlemede kolon başına kısaltma stratejisi.
    internal static PreviewColumnPlan BuildPlan(string name, string typeName, short maxLength)
    {
        const int TextChars = TextLimit;
        const int BinaryBytes = 64;

        // Tanımlayıcılar yalnızca gerektiğinde köşeli parantezlenir (SqlIdentifier.Quote).
        // Takma ad da yalnızca ifade sarmalandığında yazılır: düz bir kolonda
        // "Id AS Id" yazmanın hiçbir karşılığı yok.
        string quoted = SqlIdentifier.Quote(name);
        string alias = $" AS {quoted}";
        string t = typeName.ToLowerInvariant();

        // max_length: metin tiplerinde bayt cinsinden (-1 = max), nvarchar'da karakterin iki katı.
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

            // CLR tipleri nvarchar'a cast edilemez; hex gösterime düşülür.
            case "geography" or "geometry" or "hierarchyid":
                return new PreviewColumnPlan(name, typeName, true,
                    $"CONVERT(varchar({BinaryBytes * 2 + 2}), CONVERT(varbinary({BinaryBytes}), CONVERT(varbinary(max), {quoted})), 1){alias}");

            default:
                // Sarmalama yok: kolonun kendisi zaten sonuç kolonunun adını taşır.
                return new PreviewColumnPlan(name, typeName, false, quoted);
        }
    }

    // JSON'a güvenli değer dönüşümü. bigint ve decimal, JavaScript'in güvenli tam sayı
    // aralığını aşabildiği için hassasiyet kaybetmemek adına metne çevrilir.
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
