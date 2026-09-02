using Microsoft.Data.SqlClient;
using SqlMetadataGenerator.Connections;
using SqlMetadataGenerator.Exploration;

namespace SqlMetadataGenerator.Web.Endpoints;

// API rotaları UI rotalarını birebir aynalar:
//   app/<alias>/<db>/tables/<schema>/<name>
//   /api/servers/<alias>/databases/<db>/tables/<schema>/<name>
// Tek zihinsel model; adres çubuğundaki yolu API'de aramak zorunda kalmazsın.
internal static class ExplorerEndpoints
{
    // Tablo detayında gösterilen örnek önizleme sorgusunun satır sınırı.
    private const int DefaultPreviewTop = 20;

    public static void MapExplorerEndpoints(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        api.MapGet("/health", () => Results.Ok(new { status = "ok" }));

        // Bağlantı listesi. Parola veya bağlantı dizesi ASLA dönmez.
        api.MapGet("/servers", (ConnectionRegistry registry) =>
            Results.Ok(registry.All.Select(c => new
            {
                c.Alias,
                c.Server,
                c.Auth,
                c.User,
                c.Description,
                passwordEnv = c.ResolvedPasswordEnv,
                passwordSet = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable(c.ResolvedPasswordEnv)),
            })));

        // Sunucu dashboard'u: sürüm + tüm veritabanları, tek bağlantı üzerinden.
        api.MapGet("/servers/{alias}", (string alias, ConnectionRegistry registry, CancellationToken ct) =>
            WithServer(alias, registry, async explorer =>
            {
                var infoTask = explorer.ReadServerInfoAsync(ct);
                var dbTask = explorer.ReadDatabasesAsync(ct);
                await Task.WhenAll(infoTask, dbTask);
                return Results.Ok(new { server = await infoTask, databases = await dbTask });
            }));

        api.MapGet("/servers/{alias}/databases", (string alias, ConnectionRegistry registry, CancellationToken ct) =>
            WithServer(alias, registry, async explorer => Results.Ok(await explorer.ReadDatabasesAsync(ct))));

        // DB dashboard'u: nesne sayaçları + şemalar.
        api.MapGet("/servers/{alias}/databases/{db}", (string alias, string db, ConnectionRegistry registry, CancellationToken ct) =>
            WithDatabase(alias, db, registry, async (explorer, connectionString) =>
            {
                var countsTask = explorer.ReadObjectCountsAsync(ct);
                var schemasTask = new MetadataReader(connectionString).ReadSchemasAsync(ct);
                await Task.WhenAll(countsTask, schemasTask);
                return Results.Ok(new { database = db, counts = await countsTask, schemas = await schemasTask });
            }));

        // Treemap ve tablo grid'ini besleyen istatistikler.
        api.MapGet("/servers/{alias}/databases/{db}/tables", (string alias, string db, ConnectionRegistry registry, CancellationToken ct) =>
            WithDatabase(alias, db, registry, async (explorer, _) => Results.Ok(await explorer.ReadTableStatsAsync(ct))));

        // Kolon listesi. Veri sekmesi bunu BEKLEMEZ — önizleme kendi metadatasını
        // taşır; bu uç yalnızca "columns" sekmesine geçilince çağrılır.
        api.MapGet("/servers/{alias}/databases/{db}/tables/{schema}/{name}",
            (string alias, string db, string schema, string name, ConnectionRegistry registry, CancellationToken ct) =>
            WithDatabase(alias, db, registry, async (explorer, _) =>
            {
                var shape = await explorer.ReadTableShapeAsync(schema, name, ct);
                if (shape is null)
                {
                    return NotFound($"Table not found: {schema}.{name}");
                }

                return Results.Ok(new { shape.Schema, shape.Name, shape.Columns });
            }));

        // TOP N önizleme. Opsiyonel where ile filtrelenebilir; URL'de olduğu için
        // filtrelenmiş bir önizleme de bookmark'lanabilir.
        api.MapGet("/servers/{alias}/databases/{db}/tables/{schema}/{name}/preview",
            (string alias, string db, string schema, string name, ConnectionRegistry registry,
             CancellationToken ct, int top = 20, string? where = null) =>
            WithDatabase(alias, db, registry, async (explorer, _) =>
            {
                if (where is not null && !WhereClauseGuard.TryValidate(where, out string? guardError))
                {
                    return BadRequest(guardError!);
                }

                var shape = await explorer.ReadTableShapeAsync(schema, name, ct);
                if (shape is null)
                {
                    return NotFound($"Table not found: {schema}.{name}");
                }

                int capped = Math.Clamp(top, 1, 500);
                return Results.Ok(await explorer.PreviewAsync(shape, capped, where, ct: ct));
            }));

        // "Doğrula & Say": WHERE'i hem sözdizimsel olarak sınar hem eşleşen satır sayısını verir.
        api.MapGet("/servers/{alias}/databases/{db}/tables/{schema}/{name}/count",
            (string alias, string db, string schema, string name, ConnectionRegistry registry,
             CancellationToken ct, string? where = null) =>
            WithDatabase(alias, db, registry, async (explorer, _) =>
            {
                if (where is not null && !WhereClauseGuard.TryValidate(where, out string? guardError))
                {
                    return BadRequest(guardError!);
                }

                var shape = await explorer.ReadTableShapeAsync(schema, name, ct);
                if (shape is null)
                {
                    return NotFound($"Table not found: {schema}.{name}");
                }

                long count = await explorer.CountAsync(shape.Schema, shape.Name, where, ct: ct);
                return Results.Ok(new { rows = count, where });
            }));
    }

    private static async Task<IResult> WithServer(
        string alias, ConnectionRegistry registry, Func<ServerExplorer, Task<IResult>> action)
    {
        var entry = registry.Find(alias);
        if (entry is null)
        {
            return NotFound($"Connection not found: '{alias}'.");
        }

        return await Guarded(() =>
        {
            string cs = ConnectionRegistry.BuildConnectionString(entry, null);
            return action(new ServerExplorer(cs));
        });
    }

    private static async Task<IResult> WithDatabase(
        string alias, string database, ConnectionRegistry registry,
        Func<DataExplorer, string, Task<IResult>> action)
    {
        var entry = registry.Find(alias);
        if (entry is null)
        {
            return NotFound($"Connection not found: '{alias}'.");
        }

        return await Guarded(() =>
        {
            string cs = ConnectionRegistry.BuildConnectionString(entry, database);
            return action(new DataExplorer(cs), cs);
        });
    }

    // SQL hatalarını 400'e çevirir: kullanıcının yazdığı WHERE hatalıysa bunu hata
    // mesajıyla birlikte görmesi gerekir — 500 sayfası işe yaramaz.
    private static async Task<IResult> Guarded(Func<Task<IResult>> action)
    {
        try
        {
            return await action();
        }
        catch (InvalidOperationException ex)
        {
            return Results.Problem(title: "Connection configuration", detail: ex.Message, statusCode: 400);
        }
        catch (SqlException ex)
        {
            return Results.Problem(title: "SQL error", detail: ex.Message, statusCode: 400,
                extensions: new Dictionary<string, object?> { ["sqlNumber"] = ex.Number });
        }
    }

    private static IResult NotFound(string detail) =>
        Results.Problem(title: "Not found", detail: detail, statusCode: 404);

    private static IResult BadRequest(string detail) =>
        Results.Problem(title: "Bad request", detail: detail, statusCode: 400);
}
