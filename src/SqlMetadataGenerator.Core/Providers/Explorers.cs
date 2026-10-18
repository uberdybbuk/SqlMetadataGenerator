using SqlMetadataGenerator.Exploration;
using SqlMetadataGenerator.Model;

namespace SqlMetadataGenerator.Providers;

// What the web asks of a server, whichever engine is behind it.
public interface IServerExplorer
{
    Task<ServerInfo> ReadServerInfoAsync(CancellationToken ct = default);
    Task<List<DatabaseInfo>> ReadDatabasesAsync(CancellationToken ct = default);
}

// What the web asks of one database. Every method here answers from catalog views without
// scanning user data — the one promise that has to hold on both engines.
public interface IDataExplorer
{
    Task<List<TableStats>> ReadTableStatsAsync(CancellationToken ct = default);
    Task<Dictionary<string, int>> ReadObjectCountsAsync(CancellationToken ct = default);
    Task<List<ObjectSummary>> ReadObjectsAsync(string kind, CancellationToken ct = default);
    Task<TableFacts?> ReadTableFactsAsync(string schema, string name, CancellationToken ct = default);
    Task<QueryResult> RunQueryAsync(string sql, int maxRows = 1000, int timeoutSeconds = 30, CancellationToken ct = default);
    Task<ObjectDetail?> ReadModuleDefinitionAsync(string schema, string name, CancellationToken ct = default);
    Task<TableShape?> ReadTableShapeAsync(string schema, string name, CancellationToken ct = default);
    Task<PreviewResult> PreviewAsync(TableShape shape, int top, string? where, int timeoutSeconds = 30, CancellationToken ct = default);
    Task<long> CountAsync(string schema, string table, string? where, int timeoutSeconds = 30, CancellationToken ct = default);

    // The text of the preview query, which the editor shows before the rows arrive. It differs
    // per engine (TOP versus LIMIT), so it belongs here rather than on a static.
    string BuildPreviewSql(TableShape shape, int top, string? where);
}

// The slice of the metadata reader the web needs. The generator's full reader stays SQL
// Server-only; this is what browsing and the diagram require.
//
// ReadInventoryAsync is deliberately NOT here. It feeds the scripting picker, and scripting is
// SQL Server only — a PostgreSQL inventory would fill a picker whose Generate button cannot
// work. The endpoint refuses up front instead.
public interface ICatalogReader
{
    Task<List<TableInfo>> ReadTablesAsync(IProgress<int>? progress = null, CancellationToken ct = default);
    Task<List<SchemaInfo>> ReadSchemasAsync(CancellationToken ct = default);
}
