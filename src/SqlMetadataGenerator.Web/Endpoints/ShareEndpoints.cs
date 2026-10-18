using SqlMetadataGenerator.Connections;
using SqlMetadataGenerator.Exploration;
using SqlMetadataGenerator.Sharing;

namespace SqlMetadataGenerator.Web.Endpoints;

// Sharing a query: keep the text server-side and hand back an id short enough to paste into a
// chat. The link that carries it is an ordinary application URL — /app/<alias>/<db>/query?q=<id>
// — so it says which server and database it opens before anyone clicks it.
//
// Opening a share NEVER runs it. The text lands in the editor and waits for Execute, which is
// the same rule the query endpoint states: a link must not be able to make a machine run SQL.
internal static class ShareEndpoints
{
    public static void MapShareEndpoints(this WebApplication app)
    {
        var api = app.MapGroup("/api/shares");

        api.MapPost("", (ShareRequest body, SharedQueryStore store, ConnectionRegistry registry) =>
        {
            // Validated with the SAME guard the runner uses, at save time rather than at open
            // time. Otherwise a link could carry a DROP that only fails when the colleague
            // presses Execute — at which point the tool looks like it tried to run it.
            if (!QueryGuard.TryValidate(body.Sql, out string? error))
            {
                return BadRequest(error!);
            }

            if (string.IsNullOrWhiteSpace(body.Alias) || string.IsNullOrWhiteSpace(body.Database))
            {
                return BadRequest("A share needs the connection and the database it belongs to.");
            }

            if (registry.Find(body.Alias) is null)
            {
                return BadRequest($"Connection not found: '{body.Alias}'.");
            }

            if (body.Title is { Length: > SharedQueryStore.MaxTitleLength })
            {
                return BadRequest($"The title can be at most {SharedQueryStore.MaxTitleLength} characters.");
            }

            try
            {
                var saved = store.Save(body.Alias, body.Database, body.Sql!, body.Title);
                return Results.Ok(new { saved.Id, saved.Alias, saved.Database, saved.Title, saved.CreatedUtc });
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return Results.Problem(title: "Could not save the shared query", detail: ex.Message, statusCode: 500);
            }
        });

        api.MapGet("/{id}", (string id, SharedQueryStore store) =>
        {
            var found = store.Find(id);
            return found is null
                ? Results.Problem(
                    title: "Not found",
                    detail: "This shared query no longer exists. Ask whoever sent the link to share it again.",
                    statusCode: 404)
                : Results.Ok(found);
        });
    }

    // The share as it arrives. Title is optional: most links are sent with a sentence of context
    // beside them in the chat, and forcing a name on every one would be a toll booth.
    public sealed record ShareRequest(string? Alias, string? Database, string? Sql, string? Title);

    private static IResult BadRequest(string detail) =>
        Results.Problem(title: "Bad request", detail: detail, statusCode: 400);
}
