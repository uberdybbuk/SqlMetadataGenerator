using Microsoft.Data.SqlClient;
using SqlMetadataGenerator.Model;

namespace SqlMetadataGenerator;

/// <summary>
/// SQL Server sistem katalog view'larından tablo, view ve modül metadatasını okur.
///
/// Paralellik: her okuma kendi bağlantısını açar (SqlConnection thread-safe değildir), böylece
/// bağımsız sorgular aynı anda çalışabilir. Modül tanımları (view/sp/function/trigger) tek dev
/// result set yerine object_id'ye göre paketler hâlinde, paralel çekilir.
/// </summary>
public sealed class MetadataReader(string connectionString)
{
    private const int ModuleBatchSize = 1000;
    private readonly string _connectionString = connectionString;

    private async Task<SqlConnection> OpenConnectionAsync(CancellationToken ct)
    {
        var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        return conn;
    }

    /// <summary>Veritabanının varsayılan collation'ı (DB default ile eşleşen kolonlarda COLLATE yazmamak için).</summary>
    public async Task<string?> ReadDatabaseCollationAsync(CancellationToken ct = default)
    {
        const string sql = "SELECT CONVERT(nvarchar(128), DATABASEPROPERTYEX(DB_NAME(), 'Collation'));";
        await using var conn = await OpenConnectionAsync(ct);
        await using var cmd = new SqlCommand(sql, conn);
        var result = await cmd.ExecuteScalarAsync(ct);
        return result is null or DBNull ? null : (string)result;
    }

    public async Task<List<TableInfo>> ReadTablesAsync(CancellationToken ct = default)
    {
        // Bağımsız metadata sorgularını aynı anda çalıştır (her biri kendi bağlantısını açar).
        var namesTask = ReadTableNamesAsync(ct);
        var columnsTask = ReadColumnsAsync(ct);
        var pkTask = ReadPrimaryKeysAsync(ct);
        var uniqueTask = ReadUniqueConstraintsAsync(ct);
        var indexTask = ReadIndexesAsync(ct);
        var checkTask = ReadCheckConstraintsAsync(ct);
        var fkTask = ReadForeignKeysAsync(ct);
        await Task.WhenAll(namesTask, columnsTask, pkTask, uniqueTask, indexTask, checkTask, fkTask);

        var names = await namesTask;
        var columnsByObject = await columnsTask;
        var pkByObject = await pkTask;
        var uniqueByObject = await uniqueTask;
        var indexesByObject = await indexTask;
        var checksByObject = await checkTask;
        var fksByObject = await fkTask;

        var tables = new List<TableInfo>(names.Count);
        foreach (var (objectId, name) in names)
        {
            tables.Add(new TableInfo
            {
                Name = name,
                Columns = columnsByObject.TryGetValue(objectId, out var cols) ? cols : [],
                PrimaryKey = pkByObject.GetValueOrDefault(objectId),
                UniqueConstraints = uniqueByObject.TryGetValue(objectId, out var uqs) ? uqs : [],
                Indexes = indexesByObject.TryGetValue(objectId, out var idx) ? idx : [],
                CheckConstraints = checksByObject.TryGetValue(objectId, out var chks) ? chks : [],
                ForeignKeys = fksByObject.TryGetValue(objectId, out var fks) ? fks : [],
            });
        }

        return tables;
    }

    private async Task<List<(int ObjectId, ObjectName Name)>> ReadTableNamesAsync(CancellationToken ct)
    {
        const string sql = """
            SELECT t.object_id, s.name AS SchemaName, t.name AS TableName
            FROM sys.tables t
            JOIN sys.schemas s ON t.schema_id = s.schema_id
            WHERE t.is_ms_shipped = 0 AND t.type = 'U'
            ORDER BY s.name, t.name;
            """;

        var names = new List<(int, ObjectName)>();
        await using var conn = await OpenConnectionAsync(ct);
        await using var cmd = new SqlCommand(sql, conn);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            names.Add((reader.GetInt32(0), new ObjectName(reader.GetString(1), reader.GetString(2))));
        return names;
    }

    private async Task<Dictionary<int, List<ColumnInfo>>> ReadColumnsAsync(CancellationToken ct)
    {
        const string sql = """
            SELECT
                c.object_id,
                c.name,
                c.column_id,
                ty.name AS type_name,
                ty.is_user_defined,
                c.max_length,
                c.precision,
                c.scale,
                c.is_nullable,
                c.is_identity,
                ic.seed_value,
                ic.increment_value,
                cc.definition AS computed_definition,
                dc.name AS default_name,
                dc.definition AS default_definition,
                c.collation_name
            FROM sys.columns c
            JOIN sys.objects o ON c.object_id = o.object_id
            JOIN sys.types ty ON c.user_type_id = ty.user_type_id
            LEFT JOIN sys.identity_columns ic ON c.object_id = ic.object_id AND c.column_id = ic.column_id
            LEFT JOIN sys.computed_columns cc ON c.object_id = cc.object_id AND c.column_id = cc.column_id
            LEFT JOIN sys.default_constraints dc ON c.default_object_id = dc.object_id
            WHERE o.is_ms_shipped = 0 AND o.type = 'U'
            ORDER BY c.object_id, c.column_id;
            """;

        var map = new Dictionary<int, List<ColumnInfo>>();
        await using var conn = await OpenConnectionAsync(ct);
        await using var cmd = new SqlCommand(sql, conn);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            int objectId = reader.GetInt32(0);
            var col = new ColumnInfo
            {
                Name = reader.GetString(1),
                ColumnId = reader.GetInt32(2),
                TypeName = reader.GetString(3),
                IsUserDefinedType = reader.GetBoolean(4),
                MaxLength = reader.GetInt16(5),
                Precision = reader.GetByte(6),
                Scale = reader.GetByte(7),
                IsNullable = reader.GetBoolean(8),
                IsIdentity = reader.GetBoolean(9),
                IdentitySeed = reader.IsDBNull(10) ? null : Convert.ToInt64(reader.GetValue(10)),
                IdentityIncrement = reader.IsDBNull(11) ? null : Convert.ToInt64(reader.GetValue(11)),
                ComputedDefinition = reader.IsDBNull(12) ? null : reader.GetString(12),
                IsComputed = !reader.IsDBNull(12),
                DefaultConstraintName = reader.IsDBNull(13) ? null : reader.GetString(13),
                DefaultDefinition = reader.IsDBNull(14) ? null : reader.GetString(14),
                CollationName = reader.IsDBNull(15) ? null : reader.GetString(15),
            };

            if (!map.TryGetValue(objectId, out var list))
            {
                list = [];
                map[objectId] = list;
            }
            list.Add(col);
        }

        return map;
    }

    private async Task<Dictionary<int, PrimaryKeyInfo>> ReadPrimaryKeysAsync(CancellationToken ct)
    {
        const string sql = """
            SELECT
                i.object_id,
                i.name,
                i.type_desc,
                c.name AS column_name,
                ic.is_descending_key,
                ic.key_ordinal
            FROM sys.indexes i
            JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
            JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
            JOIN sys.objects o ON i.object_id = o.object_id
            WHERE i.is_primary_key = 1 AND o.is_ms_shipped = 0
            ORDER BY i.object_id, ic.key_ordinal;
            """;

        // object_id -> (name, isClustered, columns)
        var accumulator = new Dictionary<int, (string Name, bool Clustered, List<(string, bool)> Cols)>();
        await using var conn = await OpenConnectionAsync(ct);
        await using var cmd = new SqlCommand(sql, conn);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            int objectId = reader.GetInt32(0);
            if (!accumulator.TryGetValue(objectId, out var entry))
            {
                entry = (reader.GetString(1), reader.GetString(2) == "CLUSTERED", []);
                accumulator[objectId] = entry;
            }
            entry.Cols.Add((reader.GetString(3), reader.GetBoolean(4)));
        }

        return accumulator.ToDictionary(
            kvp => kvp.Key,
            kvp => new PrimaryKeyInfo
            {
                Name = kvp.Value.Name,
                IsClustered = kvp.Value.Clustered,
                Columns = kvp.Value.Cols,
            });
    }

    private async Task<Dictionary<int, List<UniqueConstraintInfo>>> ReadUniqueConstraintsAsync(CancellationToken ct)
    {
        const string sql = """
            SELECT
                i.object_id,
                i.index_id,
                i.name,
                i.type_desc,
                c.name AS column_name,
                ic.is_descending_key
            FROM sys.indexes i
            JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
            JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
            JOIN sys.objects o ON i.object_id = o.object_id
            WHERE i.is_unique_constraint = 1 AND o.is_ms_shipped = 0 AND o.type = 'U'
            ORDER BY i.object_id, i.index_id, ic.key_ordinal;
            """;

        // (object_id, index_id) -> birikim
        var acc = new Dictionary<(int, int), (string Name, bool Clustered, List<(string, bool)> Cols, int ObjectId)>();
        await using var conn = await OpenConnectionAsync(ct);
        await using var cmd = new SqlCommand(sql, conn);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            int objectId = reader.GetInt32(0);
            int indexId = reader.GetInt32(1);
            var key = (objectId, indexId);
            if (!acc.TryGetValue(key, out var entry))
            {
                entry = (reader.GetString(2), reader.GetString(3) == "CLUSTERED", [], objectId);
                acc[key] = entry;
            }
            entry.Cols.Add((reader.GetString(4), reader.GetBoolean(5)));
        }

        var map = new Dictionary<int, List<UniqueConstraintInfo>>();
        foreach (var entry in acc.Values)
        {
            if (!map.TryGetValue(entry.ObjectId, out var list))
            {
                list = [];
                map[entry.ObjectId] = list;
            }
            list.Add(new UniqueConstraintInfo
            {
                Name = entry.Name,
                IsClustered = entry.Clustered,
                Columns = entry.Cols,
            });
        }
        return map;
    }

    private async Task<Dictionary<int, List<IndexInfo>>> ReadIndexesAsync(CancellationToken ct)
    {
        // PK ve unique constraint'ler ayrı ele alınır (PK inline; unique constraint sonraki adım).
        // Yalnızca rowstore index'ler: type 1 = clustered, 2 = nonclustered.
        const string sql = """
            SELECT
                i.object_id,
                i.index_id,
                i.name,
                i.type_desc,
                i.is_unique,
                i.has_filter,
                i.filter_definition,
                ic.is_included_column,
                ic.is_descending_key,
                c.name AS column_name
            FROM sys.indexes i
            JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
            JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
            JOIN sys.objects o ON i.object_id = o.object_id
            WHERE i.is_primary_key = 0 AND i.is_unique_constraint = 0
              AND i.type IN (1, 2)
              AND o.is_ms_shipped = 0 AND o.type = 'U'
            ORDER BY i.object_id, i.index_id, ic.is_included_column, ic.key_ordinal, ic.index_column_id;
            """;

        // (object_id, index_id) -> birikim
        var acc = new Dictionary<(int, int), (IndexBuilder Builder, int ObjectId)>();
        await using var conn = await OpenConnectionAsync(ct);
        await using var cmd = new SqlCommand(sql, conn);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            int objectId = reader.GetInt32(0);
            int indexId = reader.GetInt32(1);
            var key = (objectId, indexId);
            if (!acc.TryGetValue(key, out var entry))
            {
                entry = (new IndexBuilder
                {
                    Name = reader.GetString(2),
                    IsClustered = reader.GetString(3) == "CLUSTERED",
                    IsUnique = reader.GetBoolean(4),
                    FilterDefinition = reader.GetBoolean(5) && !reader.IsDBNull(6) ? reader.GetString(6) : null,
                }, objectId);
                acc[key] = entry;
            }

            bool included = reader.GetBoolean(7);
            string columnName = reader.GetString(9);
            if (included)
                entry.Builder.IncludedColumns.Add(columnName);
            else
                entry.Builder.KeyColumns.Add((columnName, reader.GetBoolean(8)));
        }

        var map = new Dictionary<int, List<IndexInfo>>();
        foreach (var (builder, objectId) in acc.Values)
        {
            if (!map.TryGetValue(objectId, out var list))
            {
                list = [];
                map[objectId] = list;
            }
            list.Add(builder.Build());
        }
        return map;
    }

    private sealed class IndexBuilder
    {
        public required string Name { get; init; }
        public required bool IsClustered { get; init; }
        public required bool IsUnique { get; init; }
        public string? FilterDefinition { get; init; }
        public List<(string, bool)> KeyColumns { get; } = [];
        public List<string> IncludedColumns { get; } = [];

        public IndexInfo Build() => new()
        {
            Name = Name,
            IsUnique = IsUnique,
            IsClustered = IsClustered,
            KeyColumns = KeyColumns,
            IncludedColumns = IncludedColumns,
            FilterDefinition = FilterDefinition,
        };
    }

    private async Task<Dictionary<int, List<ForeignKeyInfo>>> ReadForeignKeysAsync(CancellationToken ct)
    {
        const string sql = """
            SELECT
                fk.parent_object_id,
                fk.object_id,
                fk.name,
                fk.delete_referential_action_desc,
                fk.update_referential_action_desc,
                fk.is_disabled,
                fk.is_not_trusted,
                fk.is_not_for_replication,
                rs.name AS ref_schema,
                rt.name AS ref_table,
                pc.name AS parent_column,
                rc.name AS ref_column
            FROM sys.foreign_keys fk
            JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
            JOIN sys.columns pc ON fkc.parent_object_id = pc.object_id AND fkc.parent_column_id = pc.column_id
            JOIN sys.columns rc ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id
            JOIN sys.tables rt ON fk.referenced_object_id = rt.object_id
            JOIN sys.schemas rs ON rt.schema_id = rs.schema_id
            JOIN sys.objects o ON fk.parent_object_id = o.object_id
            WHERE o.is_ms_shipped = 0
            ORDER BY fk.parent_object_id, fk.object_id, fkc.constraint_column_id;
            """;

        // fk.object_id -> birikim
        var acc = new Dictionary<int, (ForeignKeyBuilder Builder, int ParentObjectId)>();
        await using var conn = await OpenConnectionAsync(ct);
        await using var cmd = new SqlCommand(sql, conn);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            int parentObjectId = reader.GetInt32(0);
            int fkObjectId = reader.GetInt32(1);
            if (!acc.TryGetValue(fkObjectId, out var entry))
            {
                entry = (new ForeignKeyBuilder
                {
                    Name = reader.GetString(2),
                    DeleteAction = reader.GetString(3),
                    UpdateAction = reader.GetString(4),
                    IsDisabled = reader.GetBoolean(5),
                    IsNotTrusted = reader.GetBoolean(6),
                    IsNotForReplication = reader.GetBoolean(7),
                    ReferencedTable = new ObjectName(reader.GetString(8), reader.GetString(9)),
                }, parentObjectId);
                acc[fkObjectId] = entry;
            }
            entry.Builder.Columns.Add(reader.GetString(10));
            entry.Builder.ReferencedColumns.Add(reader.GetString(11));
        }

        var map = new Dictionary<int, List<ForeignKeyInfo>>();
        foreach (var (builder, parentObjectId) in acc.Values)
        {
            if (!map.TryGetValue(parentObjectId, out var list))
            {
                list = [];
                map[parentObjectId] = list;
            }
            list.Add(builder.Build());
        }
        return map;
    }

    private sealed class ForeignKeyBuilder
    {
        public required string Name { get; init; }
        public required string DeleteAction { get; init; }
        public required string UpdateAction { get; init; }
        public required bool IsDisabled { get; init; }
        public required bool IsNotTrusted { get; init; }
        public required bool IsNotForReplication { get; init; }
        public required ObjectName ReferencedTable { get; init; }
        public List<string> Columns { get; } = [];
        public List<string> ReferencedColumns { get; } = [];

        public ForeignKeyInfo Build() => new()
        {
            Name = Name,
            Columns = Columns,
            ReferencedTable = ReferencedTable,
            ReferencedColumns = ReferencedColumns,
            DeleteAction = DeleteAction,
            UpdateAction = UpdateAction,
            IsDisabled = IsDisabled,
            IsNotTrusted = IsNotTrusted,
            IsNotForReplication = IsNotForReplication,
        };
    }

    public async Task<Dictionary<int, List<CheckConstraintInfo>>> ReadCheckConstraintsAsync(CancellationToken ct = default)
    {
        const string sql = """
            SELECT
                cc.parent_object_id,
                cc.name,
                cc.definition,
                cc.is_disabled,
                cc.is_not_trusted,
                cc.is_not_for_replication
            FROM sys.check_constraints cc
            JOIN sys.objects o ON cc.parent_object_id = o.object_id
            WHERE o.is_ms_shipped = 0 AND o.type = 'U'
            ORDER BY cc.parent_object_id, cc.name;
            """;

        var map = new Dictionary<int, List<CheckConstraintInfo>>();
        await using var conn = await OpenConnectionAsync(ct);
        await using var cmd = new SqlCommand(sql, conn);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            int parentObjectId = reader.GetInt32(0);
            var check = new CheckConstraintInfo
            {
                Name = reader.GetString(1),
                Definition = reader.GetString(2),
                IsDisabled = reader.GetBoolean(3),
                IsNotTrusted = reader.GetBoolean(4),
                IsNotForReplication = reader.GetBoolean(5),
            };

            if (!map.TryGetValue(parentObjectId, out var list))
            {
                list = [];
                map[parentObjectId] = list;
            }
            list.Add(check);
        }
        return map;
    }

    /// <summary>
    /// Tüm modüllerin (view/sp/function/trigger) hafif başlıklarını okur — definition YOK.
    /// Incremental karşılaştırma ve silme tespiti bu listeden yapılır.
    /// </summary>
    public async Task<List<ModuleHeader>> ReadModuleHeadersAsync(CancellationToken ct = default)
    {
        const string sql = """
            SELECT o.object_id, s.name AS schema_name, o.name, o.type, o.modify_date
            FROM sys.objects o
            JOIN sys.schemas s ON o.schema_id = s.schema_id
            WHERE o.is_ms_shipped = 0 AND o.type IN ('V', 'P', 'FN', 'IF', 'TF', 'TR')
            ORDER BY s.name, o.name;
            """;

        var headers = new List<ModuleHeader>();
        await using var conn = await OpenConnectionAsync(ct);
        await using var cmd = new SqlCommand(sql, conn);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            headers.Add(new ModuleHeader
            {
                ObjectId = reader.GetInt32(0),
                Name = new ObjectName(reader.GetString(1), reader.GetString(2)),
                CategoryFolder = CategoryForType(reader.GetString(3).Trim()),
                ModifyDate = reader.GetDateTime(4),
            });
        }
        return headers;
    }

    /// <summary>
    /// Verilen başlıkların tanımlarını object_id'ye göre 1000'lik paketler hâlinde paralel çeker.
    /// Tek dev result set'in ağ/bellek maliyetinden kaçınır; sonuç başlık sırasını korur.
    /// </summary>
    public async Task<List<RoutineInfo>> ReadModuleDefinitionsAsync(
        IReadOnlyList<ModuleHeader> headers, CancellationToken ct = default)
    {
        var batches = new List<List<ModuleHeader>>();
        for (int i = 0; i < headers.Count; i += ModuleBatchSize)
            batches.Add(headers.Skip(i).Take(ModuleBatchSize).ToList());

        // Paralellik derecesini framework belirler (MaxDegreeOfParallelism verilmedi);
        // sıra korunur çünkü sonuçlar batch indeksiyle toplanır.
        var byBatch = new List<RoutineInfo>[batches.Count];
        await Parallel.ForEachAsync(
            Enumerable.Range(0, batches.Count),
            ct,
            async (i, token) => byBatch[i] = await ReadDefinitionsForBatchAsync(batches[i], token));

        return byBatch.SelectMany(b => b).ToList();
    }

    private async Task<List<RoutineInfo>> ReadDefinitionsForBatchAsync(List<ModuleHeader> batch, CancellationToken ct)
    {
        // object_id'ler int olduğundan IN listesine doğrudan gömmek güvenlidir.
        string ids = string.Join(",", batch.Select(h => h.ObjectId));
        string sql = $"SELECT object_id, definition FROM sys.sql_modules WHERE object_id IN ({ids});";

        var defByObject = new Dictionary<int, string>(batch.Count);
        await using var conn = await OpenConnectionAsync(ct);
        await using var cmd = new SqlCommand(sql, conn);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            defByObject[reader.GetInt32(0)] = reader.IsDBNull(1) ? string.Empty : reader.GetString(1);

        return batch.Select(h => new RoutineInfo
        {
            Name = h.Name,
            Definition = defByObject.GetValueOrDefault(h.ObjectId, string.Empty),
            CategoryFolder = h.CategoryFolder,
        }).ToList();
    }

    private static string CategoryForType(string type) => type switch
    {
        "V" => "Views",
        "P" => "Programmability/Stored Procedures",
        "FN" => "Programmability/Functions/ScalarFunctions",
        "IF" or "TF" => "Programmability/Functions/TableFunctions",
        "TR" => "Programmability/Triggers",
        _ => "Programmability",
    };

    /// <summary>
    /// Kullanıcı tanımlı şemaları okur. Yerleşik şemalar (dbo/guest/sys/INFORMATION_SCHEMA ve
    /// sabit veritabanı rolü şemaları) hariç tutulur — bunlar schema_id aralığıyla ayrılır.
    /// </summary>
    public async Task<List<SchemaInfo>> ReadSchemasAsync(CancellationToken ct = default)
    {
        const string sql = """
            SELECT s.name, dp.name AS owner_name
            FROM sys.schemas s
            JOIN sys.database_principals dp ON s.principal_id = dp.principal_id
            WHERE s.schema_id BETWEEN 5 AND 16383
            ORDER BY s.name;
            """;

        var schemas = new List<SchemaInfo>();
        await using var conn = await OpenConnectionAsync(ct);
        await using var cmd = new SqlCommand(sql, conn);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            schemas.Add(new SchemaInfo { Name = reader.GetString(0), Owner = reader.GetString(1) });
        return schemas;
    }

    public async Task<List<SynonymInfo>> ReadSynonymsAsync(CancellationToken ct = default)
    {
        const string sql = """
            SELECT s.name AS schema_name, syn.name, syn.base_object_name
            FROM sys.synonyms syn
            JOIN sys.schemas s ON syn.schema_id = s.schema_id
            ORDER BY s.name, syn.name;
            """;

        var synonyms = new List<SynonymInfo>();
        await using var conn = await OpenConnectionAsync(ct);
        await using var cmd = new SqlCommand(sql, conn);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            synonyms.Add(new SynonymInfo
            {
                Name = new ObjectName(reader.GetString(0), reader.GetString(1)),
                BaseObjectName = reader.GetString(2),
            });
        }

        return synonyms;
    }
}
