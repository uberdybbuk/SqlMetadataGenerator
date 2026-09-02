using SqlMetadataGenerator.Connections;
using SqlMetadataGenerator.Web.Endpoints;

namespace SqlMetadataGenerator.Web;

internal static class Program
{
    private static void Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);

        string configured = builder.Configuration["ConnectionsFile"] ?? "connections.json";
        string? resolved = ResolveConnectionsPath(configured, builder.Environment.ContentRootPath);
        builder.Services.AddSingleton(resolved is null ? ConnectionRegistry.Empty : ConnectionRegistry.Load(resolved));

        var app = builder.Build();

        // Say plainly which file was used (or that none was found): opening silently with an
        // empty connection list produced a state that was hard to diagnose.
        var log = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Connections");
        if (resolved is null)
        {
            log.LogWarning("'{File}' not found; the connection list is empty. Copy connections.example.json.", configured);
        }
        else
        {
            log.LogInformation("Connections file: {Path}", resolved);
        }

        app.MapExplorerEndpoints();

        // In production the SPA is served from wwwroot. The fallback is required: on a client-side
        // route like /app/demo/Bpm/tables the server has no such file when the page is refreshed.
        // In development Vite serves the SPA (:5173) and proxies /api here.
        app.UseStaticFiles();
        app.MapFallbackToFile("index.html");

        app.Run();
    }

    // For a relative path, in order: the working directory, the content root, then upwards from the content root.
    // The upward search means 'dotnet run --project src/...' finds the file at the repository root
    // no matter which directory it was invoked from.
    private static string? ResolveConnectionsPath(string configured, string contentRoot)
    {
        if (Path.IsPathRooted(configured))
        {
            return File.Exists(configured) ? configured : null;
        }

        var candidates = new List<string>
        {
            Path.Combine(Directory.GetCurrentDirectory(), configured),
            Path.Combine(contentRoot, configured),
        };

        var dir = new DirectoryInfo(contentRoot);
        for (int i = 0; i < 5 && dir.Parent is not null; i++)
        {
            dir = dir.Parent;
            candidates.Add(Path.Combine(dir.FullName, configured));
        }

        return candidates.FirstOrDefault(File.Exists);
    }
}
