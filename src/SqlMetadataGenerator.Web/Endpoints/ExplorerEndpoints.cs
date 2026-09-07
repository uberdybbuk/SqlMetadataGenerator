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

    // How many rows a free-form query returns before the reader stops. A browser grid is not a
    // place to put a million rows, and the connection should not be held open while they arrive.
    private const int DefaultMaxRows = 1000;

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

        // The CREATE script for one table, produced by the same Scripting layer the generator uses
        // — what you read here is what would land in the .sql file, columns, indexes, check
        // constraints and foreign keys included.
        //
        // The read is whole-database: MetadataReader assembles a TableInfo from seven catalog
        // queries that span every table, and one table cannot be carved out of them without a
        // second, near-duplicate read path that would then be free to drift from the generator's.
        // The tab is only fetched when it is opened, so the cost lands on a deliberate click.
        api.MapGet("/servers/{alias}/databases/{db}/tables/{schema}/{name}/script",
            (string alias, string db, string schema, string name, ConnectionRegistry registry, CancellationToken ct) =>
            WithDatabase(alias, db, registry, async (_, connectionString) =>
            {
                var reader = new MetadataReader(connectionString);
                var collationTask = reader.ReadDatabaseCollationAsync(ct);
                var tablesTask = reader.ReadTablesAsync(null, ct);
                await Task.WhenAll(collationTask, tablesTask);

                var table = (await tablesTask).FirstOrDefault(t =>
                    string.Equals(t.Name.Schema, schema, StringComparison.OrdinalIgnoreCase) &&
                    string.Equals(t.Name.Name, name, StringComparison.OrdinalIgnoreCase));
                if (table is null)
                {
                    return NotFound($"Table not found: {schema}.{name}");
                }

                var fmt = new ScriptFormat { DatabaseCollation = await collationTask };
                return Results.Ok(new { Sql = TableScripter.Script(table, fmt) });
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

        // A statement the user typed. POST because a query does not belong in a URL, and because
        // running one is not something a link should be able to do on its own.
        //
        // Two things stand between the text and the server: QueryGuard, which only lets a single
        // SELECT through, and the login itself, which is the protection that actually matters.
        // A syntax error comes back as 400 with the server's own message — the person writing the
        // query needs to read it.
        api.MapPost("/servers/{alias}/databases/{db}/query",
            (string alias, string db, QueryRequest body, ConnectionRegistry registry, CancellationToken ct) =>
            WithDatabase(alias, db, registry, async (explorer, _) =>
            {
                if (!QueryGuard.TryValidate(body.Sql, out string? guardError))
                {
                    return BadRequest(guardError!);
                }

                int rows = Math.Clamp(body.MaxRows ?? DefaultMaxRows, 1, 5000);
                return Results.Ok(await explorer.RunQueryAsync(body.Sql!, rows, ct: ct));
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

        // The scripting picker's inventory: the name of every object the generator can script.
        // One round trip, names only — the tree is drawn before anything is read in full.
        api.MapGet("/servers/{alias}/databases/{db}/scriptable",
            (string alias, string db, ConnectionRegistry registry, CancellationToken ct) =>
            WithDatabase(alias, db, registry, async (_, connectionString) =>
            {
                var reader = new MetadataReader(connectionString);
                return Results.Ok(new
                {
                    Kinds = ScriptBundle.Kinds.Select(k => new { Kind = k, Title = ScriptBundle.Title(k) }),
                    Objects = await reader.ReadInventoryAsync(ct),
                });
            }));

        // Scripts the chosen objects into ONE statement, sections in dependency order.
        //
        // POST because the selection is a list, not an address: seventeen schema-qualified names do
        // not belong in a URL, and generating a script is not something a link should do on its own.
        api.MapPost("/servers/{alias}/databases/{db}/script",
            (string alias, string db, ScriptRequest body, ConnectionRegistry registry, CancellationToken ct) =>
            WithDatabase(alias, db, registry, async (_, connectionString) =>
            {
                if (!TryReadSelection(body, out var wanted, out string? error)
                    || !TryReadData(body, out var data, out error))
                {
                    return BadRequest(error!);
                }

                var reader = new MetadataReader(connectionString);
                var format = body.ToScriptFormat(await reader.ReadDatabaseCollationAsync(ct));
                var bundle = await ScriptBundle.BuildAsync(reader, wanted, data, connectionString, format, ct);

                return Results.Ok(new
                {
                    Sql = ScriptBundle.ToSingleScript(bundle, format),
                    Scripted = bundle.Items.Count,
                    // What was asked for and is no longer there. The panel's inventory can be
                    // minutes old, and a dropped object has to be said out loud.
                    bundle.Missing,
                    // Non-empty when the chosen tables reference each other in a cycle: the script
                    // brackets the load with NOCHECK/CHECK, and the panel says so.
                    CycleTables = bundle.CycleTables,
                });
            }));

        // The same bundle as files, in the layout the generator writes to disk, zipped.
        api.MapPost("/servers/{alias}/databases/{db}/script/files",
            (string alias, string db, ScriptRequest body, ConnectionRegistry registry, CancellationToken ct) =>
            WithDatabase(alias, db, registry, async (_, connectionString) =>
            {
                if (!TryReadSelection(body, out var wanted, out string? error)
                    || !TryReadData(body, out var data, out error))
                {
                    return BadRequest(error!);
                }

                var reader = new MetadataReader(connectionString);
                var format = body.ToScriptFormat(await reader.ReadDatabaseCollationAsync(ct));
                var bundle = await ScriptBundle.BuildAsync(reader, wanted, data, connectionString, format, ct);

                var files = bundle.Items
                    .Select(item => (Path: ScriptBundle.FilePath(item), Content: item.Sql.TrimEnd() + "\n"))
                    .ToList();

                if (bundle.Missing.Count > 0)
                {
                    files.Add(("_missing.txt",
                        "Asked for, but no longer in the catalog:\n\n" + string.Join("\n", bundle.Missing) + "\n"));
                }

                // 7-Zip at -mx=9 when the host has it, a zip when it does not. See ScriptArchive.
                var package = await ScriptArchive.PackAsync(files, ct);
                string stamp = DateTime.Now.ToString("yyyyMMdd-HHmm");
                return Results.File(package.Bytes, package.ContentType, $"{db}-{stamp}{package.Extension}");
            }));
    }

    // The selection as it arrives from the picker. Capped so a malformed or hostile body cannot
    // ask for an unbounded read; the cap is far above any real database's object count.
    private const int MaxSelectedObjects = 20000;

    // The row selections, with their WHERE clauses checked by the same guard the preview uses.
    // A WHERE is the one part of this request that becomes SQL text, so it never goes unchecked.
    private static bool TryReadData(
        ScriptRequest body, out List<DataScripter.Request> data, out string? error)
    {
        data = [];
        error = null;

        foreach (var d in body.Data ?? [])
        {
            if (string.IsNullOrWhiteSpace(d.Schema) || string.IsNullOrWhiteSpace(d.Name))
            {
                error = "A data entry is missing its schema or table name.";
                return false;
            }

            if (!string.IsNullOrWhiteSpace(d.Where) && !WhereClauseGuard.TryValidate(d.Where, out string? guard))
            {
                error = $"{d.Schema}.{d.Name}: {guard}";
                return false;
            }

            data.Add(new DataScripter.Request(d.Schema, d.Name, d.Where));
        }

        return true;
    }

    private static bool TryReadSelection(
        ScriptRequest body, out List<ScriptableObject> wanted, out string? error)
    {
        wanted = [];
        error = null;

        if ((body.Objects is null || body.Objects.Count == 0)
            && (body.Data is null || body.Data.Count == 0))
        {
            error = "Nothing was selected.";
            return false;
        }

        if (body.Objects is null)
        {
            return true;
        }

        if (body.Objects.Count > MaxSelectedObjects)
        {
            error = $"At most {MaxSelectedObjects} objects can be scripted at once.";
            return false;
        }

        var kinds = new HashSet<string>(ScriptBundle.Kinds, StringComparer.OrdinalIgnoreCase);
        foreach (var o in body.Objects)
        {
            if (string.IsNullOrWhiteSpace(o.Kind) || string.IsNullOrWhiteSpace(o.Name))
            {
                error = "An entry is missing its kind or name.";
                return false;
            }

            // The kind decides which reader runs, so it is checked against the closed list rather
            // than trusted. Nothing from the request reaches any SQL text either way.
            if (!kinds.Contains(o.Kind))
            {
                error = $"Unknown object kind: '{o.Kind}'.";
                return false;
            }

            wanted.Add(new ScriptableObject(o.Kind, o.Schema ?? string.Empty, o.Name));
        }

        return true;
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

    // The body of a query request. A record rather than loose parameters so the JSON shape is
    // stated once and read by the binder.
    public sealed record QueryRequest(string? Sql, int? MaxRows);

    // The scripting request: what to script, and how to format it. The formatting fields are
    // nullable so that omitting one means "the generator's default" rather than "false".
    public sealed record ScriptRequest(
        List<ScriptSelection>? Objects,
        // The tables whose ROWS were asked for. Independent of Objects: a table can appear in one,
        // the other, or both.
        List<DataSelection>? Data,
        bool? UpperCaseKeywords,
        bool? EmitSetOptions,
        bool? GroupColumns)
    {
        public ScriptFormat ToScriptFormat(string? collation) => new()
        {
            KeywordCase = UpperCaseKeywords == true ? KeywordCase.Upper : KeywordCase.Lower,
            EmitSetOptions = EmitSetOptions ?? false,
            GroupColumns = GroupColumns ?? true,
            DatabaseCollation = collation,
        };
    }

    public sealed record ScriptSelection(string Kind, string? Schema, string Name);

    public sealed record DataSelection(string Schema, string Name, string? Where);

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
