using System.Data.Common;
using Microsoft.Data.SqlClient;
using Npgsql;
using SqlMetadataGenerator.Connections;
using SqlMetadataGenerator.Exploration;
using SqlMetadataGenerator.Providers;

namespace SqlMetadataGenerator.Web.Endpoints;

// The connection list and the connection screen behind it: add, edit, remove, and try a
// connection before saving it. A password is accepted here but NEVER returned: the list says
// only whether one is stored, and the edit form leaves the field blank to mean "keep it".
internal static class ConnectionEndpoints
{
    // A connection test answers in seconds or not at all; the driver's default of 15 seconds makes
    // a mistyped server name feel like the page has hung.
    private const int TestTimeoutSeconds = 5;

    public static void MapConnectionEndpoints(this WebApplication app)
    {
        var api = app.MapGroup("/api/servers");

        api.MapGet("", (ConnectionRegistry registry) =>
            Results.Ok(registry.All.Select(c => new
            {
                c.Alias,
                c.Server,
                provider = c.Kind.Name(),
                c.Auth,
                c.User,
                c.Description,
                c.Encrypt,
                c.TrustServerCertificate,
                passwordEnv = c.ResolvedPasswordEnv,
                passwordStored = c.HasStoredPassword,
                passwordSet = c.HasStoredPassword
                    || !string.IsNullOrEmpty(Environment.GetEnvironmentVariable(c.ResolvedPasswordEnv)),
            })));

        api.MapPost("", (ConnectionRequest body, ConnectionRegistry registry) =>
            Saved(() =>
            {
                var entry = body.ToEntry(body.Alias?.Trim() ?? string.Empty, existing: null);
                registry.Add(entry);
                return Results.Created($"/api/servers/{entry.Alias}", new { entry.Alias });
            }));

        api.MapPut("/{alias}", (string alias, ConnectionRequest body, ConnectionRegistry registry) =>
            Saved(() =>
            {
                var existing = registry.Find(alias);
                if (existing is null)
                {
                    return NotFound(alias);
                }

                if (!string.IsNullOrWhiteSpace(body.Alias)
                    && !body.Alias.Trim().Equals(existing.Alias, StringComparison.OrdinalIgnoreCase))
                {
                    return BadRequest("The alias of an existing connection cannot be changed.");
                }

                registry.Update(existing.Alias, body.ToEntry(existing.Alias, existing));
                return Results.NoContent();
            }));

        api.MapDelete("/{alias}", (string alias, ConnectionRegistry registry) =>
            Saved(() => registry.Remove(alias) ? Results.NoContent() : NotFound(alias)));

        // Tries the form as it stands, saved or not. When it names an existing connection and the
        // password field was left blank, the stored password is used, so an edit can be tested
        // without typing the password again.
        api.MapPost("/test", async (ConnectionRequest body, ConnectionRegistry registry, CancellationToken ct) =>
        {
            string alias = string.IsNullOrWhiteSpace(body.Alias) ? "test" : body.Alias.Trim();
            try
            {
                var entry = body.ToEntry(alias, registry.Find(alias));
                ConnectionRegistry.Validate(entry);
                string cs = ConnectionRegistry.BuildConnectionString(entry, null);
                IServerExplorer explorer;
                if (entry.Kind == DatabaseProvider.Postgres)
                {
                    var pg = new NpgsqlConnectionStringBuilder(cs) { Timeout = TestTimeoutSeconds };
                    explorer = new PgServerExplorer(pg.ConnectionString);
                }
                else
                {
                    var sql = new SqlConnectionStringBuilder(cs) { ConnectTimeout = TestTimeoutSeconds };
                    explorer = new ServerExplorer(sql.ConnectionString);
                }

                var info = await explorer.ReadServerInfoAsync(ct);
                return Results.Ok(info);
            }
            catch (InvalidOperationException ex)
            {
                return BadRequest(ex.Message);
            }
            catch (DbException ex)
            {
                return Results.Problem(title: "Connection failed", detail: ex.Message, statusCode: 400);
            }
        });
    }

    // Validation reaches the page as a 400 with its own message. A failed write is the server's
    // problem, not the form's, but the reason (a read-only file, a locked one) is still the most
    // useful thing to show.
    private static IResult Saved(Func<IResult> action)
    {
        try
        {
            return action();
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ex.Message);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return Results.Problem(title: "Could not save connections", detail: ex.Message, statusCode: 500);
        }
    }

    private static IResult NotFound(string alias) =>
        Results.Problem(title: "Not found", detail: $"Connection not found: '{alias}'.", statusCode: 404);

    private static IResult BadRequest(string detail) =>
        Results.Problem(title: "Bad request", detail: detail, statusCode: 400);

    // The form as it arrives. Password: null keeps what is stored, "" removes it (the environment
    // variable takes over again), anything else replaces it.
    public sealed record ConnectionRequest(
        string? Alias,
        string? Server,
        string? Provider,
        string? Auth,
        string? User,
        string? Password,
        string? PasswordEnv,
        bool? Encrypt,
        bool? TrustServerCertificate,
        string? Description)
    {
        public ConnectionEntry ToEntry(string alias, ConnectionEntry? existing)
        {
            string auth = string.IsNullOrWhiteSpace(Auth) ? "sql" : Auth.Trim().ToLowerInvariant();
            bool integrated = auth == "integrated";

            string? password = Password switch
            {
                null => existing?.Password,
                "" => null,
                _ => Password,
            };

            // An absent provider means "leave it as it was", which matters on an edit: a form
            // that posts without the field would otherwise rewrite a postgres entry as sqlserver.
            string provider = (string.IsNullOrWhiteSpace(Provider) ? existing?.Provider : Provider) ?? string.Empty;

            return new ConnectionEntry
            {
                Alias = alias,
                Server = Server?.Trim() ?? string.Empty,
                // Parsed and written back in canonical form, so the file never holds "pgsql" or
                // "MSSQL" and every later read agrees about what the entry means.
                Provider = DatabaseProviders.Parse(provider).Name(),
                Auth = auth,
                // Windows authentication has no use for any of the three; keeping them would leave
                // a stale password in the file that nothing reads.
                User = integrated ? null : Blank(User),
                Password = integrated ? null : password,
                PasswordEnv = integrated ? null : Blank(PasswordEnv),
                Encrypt = Encrypt ?? true,
                TrustServerCertificate = TrustServerCertificate ?? true,
                Description = Blank(Description),
            };
        }

        private static string? Blank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }
}
