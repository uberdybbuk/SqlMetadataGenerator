using Microsoft.Data.SqlClient;
using SqlMetadataGenerator.Connections;
using SqlMetadataGenerator.Exploration;
using SqlMetadataGenerator.Model;
using SqlMetadataGenerator.Scripting;

namespace SqlMetadataGenerator.Web.Endpoints;

// The API routes mirror the UI routes exactly:
//   app/<alias>/<db>/tables/<schema>/<name>
//   /api/servers/<alias>/databases/<db>/tables/<schema>/<name>
// One mental model; you never have to hunt for the address-bar path in the API.
internal static class ExplorerEndpoints
{
    // The row limit of the sample preview query shown on the table detail page.
    private const int DefaultPreviewTop = 20;

    public static void MapExplorerEndpoints(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        api.MapGet("/health", () => Results.Ok(new { status = "ok" }));

        // The connection list. A password or a connection string is NEVER returned.
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

        // Server dashboard: version plus every database, over a single connection.
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

        // Database dashboard: object counters plus schemas.
        api.MapGet("/servers/{alias}/databases/{db}", (string alias, string db, ConnectionRegistry registry, CancellationToken ct) =>
            WithDatabase(alias, db, registry, async (explorer, connectionString) =>
            {
                var countsTask = explorer.ReadObjectCountsAsync(ct);
                var schemasTask = new MetadataReader(connectionString).ReadSchemasAsync(ct);
                await Task.WhenAll(countsTask, schemasTask);
                return Results.Ok(new { database = db, counts = await countsTask, schemas = await schemasTask });
            }));

        // One object kind, listed. The dashboard badges link here, so the counter and the list
        // read the same catalog query — a badge saying "9 synonyms" opens exactly nine rows.
        api.MapGet("/servers/{alias}/databases/{db}/objects/{kind}",
            (string alias, string db, string kind, ConnectionRegistry registry, CancellationToken ct) =>
            WithDatabase(alias, db, registry, async (explorer, _) =>
            {
                if (!DataExplorer.IsKnownKind(kind))
                {
                    return BadRequest($"Unknown object kind: {kind}");
                }

                return Results.Ok(await explorer.ReadObjectsAsync(kind, ct));
            }));

        // One object's DDL. Modules (view, procedure, function, trigger) come back as the server's
        // own CREATE text; synonyms, sequences and table types are stored as parts rather than as a
        // statement, so the same Scripting layer the generator uses composes one — the response says
        // which of the two you are looking at.
        api.MapGet("/servers/{alias}/databases/{db}/objects/{kind}/{schema}/{name}",
            (string alias, string db, string kind, string schema, string name,
             ConnectionRegistry registry, CancellationToken ct) =>
            WithDatabase(alias, db, registry, async (explorer, connectionString) =>
            {
                if (!DataExplorer.IsKnownKind(kind))
                {
                    return BadRequest($"Unknown object kind: {kind}");
                }

                if (kind.Equals("tables", StringComparison.OrdinalIgnoreCase))
                {
                    return BadRequest("Tables have their own page; use the table endpoints.");
                }

                var detail = await ReadObjectDetailAsync(explorer, connectionString, kind, schema, name, ct);
                return detail is null
                    ? NotFound($"Not found: {schema}.{name}")
                    : Results.Ok(detail);
            }));

        // The statistics behind the treemap and the table grid.
        api.MapGet("/servers/{alias}/databases/{db}/tables", (string alias, string db, ConnectionRegistry registry, CancellationToken ct) =>
            WithDatabase(alias, db, registry, async (explorer, _) => Results.Ok(await explorer.ReadTableStatsAsync(ct))));

        // Everything the detail tab shows: columns, indexes, creation and owner. The data tab does
        // NOT WAIT on this — the preview carries its own column metadata; this endpoint is called
        // only when the detail tab is opened. The two queries run at the same time, so the tab
        // costs one round trip's worth of latency rather than two.
        api.MapGet("/servers/{alias}/databases/{db}/tables/{schema}/{name}",
            (string alias, string db, string schema, string name, ConnectionRegistry registry, CancellationToken ct) =>
            WithDatabase(alias, db, registry, async (explorer, _) =>
            {
                var shapeTask = explorer.ReadTableShapeAsync(schema, name, ct);
                var factsTask = explorer.ReadTableFactsAsync(schema, name, ct);
                await Task.WhenAll(shapeTask, factsTask);

                var shape = await shapeTask;
                if (shape is null)
                {
                    return NotFound($"Table not found: {schema}.{name}");
                }

                var facts = await factsTask;
                return Results.Ok(new
                {
                    shape.Schema,
                    shape.Name,
                    shape.Columns,
                    Indexes = facts?.Indexes ?? [],
                    CreateDate = facts?.CreateDate,
                    ModifyDate = facts?.ModifyDate,
                    Owner = facts?.Owner,
                });
            }));

        // The query text on its own, without the rows. The preview endpoint knows the text as soon
        // as the catalog answers, but only ships it once the data has been read as well — so on a
        // large table the editor sat empty for as long as the scan took, which reads as the
        // application being stuck rather than as loading. This endpoint costs one catalog round
        // trip and runs alongside the preview.
        api.MapGet("/servers/{alias}/databases/{db}/tables/{schema}/{name}/sql",
            (string alias, string db, string schema, string name, ConnectionRegistry registry,
             CancellationToken ct, int top = DefaultPreviewTop, string? where = null) =>
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
                return Results.Ok(new { Sql = DataExplorer.BuildPreviewSql(shape, capped, where) });
            }));

        // The TOP N preview. It can be filtered with an optional where; because that lives in the
        // URL, a filtered preview can be bookmarked too.
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

        // "Validate & Count": tests the WHERE syntactically and returns the number of matching rows.
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

    // Modules answer from sys.sql_modules. The other three kinds have no stored statement, so the
    // whole-database reader runs and the one row is picked out: these lists are a handful of rows
    // each, and reusing the tested readers beats a second, near-duplicate single-object query.
    private static async Task<ObjectDetail?> ReadObjectDetailAsync(
        DataExplorer explorer,
        string connectionString,
        string kind,
        string schema,
        string name,
        CancellationToken ct)
    {
        if (kind is "views" or "procedures" or "functions" or "triggers")
        {
            return await explorer.ReadModuleDefinitionAsync(schema, name, ct);
        }

        var reader = new MetadataReader(connectionString);
        var fmt = new ScriptFormat();
        bool Matches(ObjectName n) =>
            string.Equals(n.Schema, schema, StringComparison.OrdinalIgnoreCase) &&
            string.Equals(n.Name, name, StringComparison.OrdinalIgnoreCase);

        switch (kind)
        {
            case "synonyms":
            {
                var hit = (await reader.ReadSynonymsAsync(ct)).FirstOrDefault(x => Matches(x.Name));
                return hit is null ? null : Compose(hit.Name, "SYNONYM", SynonymScripter.Script(hit, fmt));
            }

            case "sequences":
            {
                var hit = (await reader.ReadSequencesAsync(ct)).FirstOrDefault(x => Matches(x.Name));
                return hit is null ? null : Compose(hit.Name, "SEQUENCE_OBJECT", SequenceScripter.Script(hit, fmt));
            }

            case "types":
            {
                var hit = (await reader.ReadTableTypesAsync(ct)).FirstOrDefault(x => Matches(x.Name));
                return hit is null ? null : Compose(hit.Name, "TYPE_TABLE", TableTypeScripter.Script(hit, fmt));
            }

            default:
                return null;
        }
    }

    private static ObjectDetail Compose(ObjectName name, string typeDesc, string definition) => new()
    {
        Schema = name.Schema,
        Name = name.Name,
        TypeDesc = typeDesc,
        Definition = definition,
        Generated = true,
        // These catalogs carry no create/modify timestamps on the path we read them from.
        CreateDate = default,
        ModifyDate = default,
    };

    // Turns SQL errors into a 400: when the WHERE the user typed is wrong they need to see it
    // with the error message — a 500 page is no help.
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
