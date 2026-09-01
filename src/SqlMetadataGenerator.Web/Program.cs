namespace SqlMetadataGenerator.Web;

internal static class Program
{
    private static void Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);
        var app = builder.Build();

        // Faz 0 iskeleti: yapının ayakta olduğunu doğrulayan tek uç.
        // Katalog uçları Faz 1'de, wwwroot'tan SPA sunumu Faz 2'de eklenecek.
        app.MapGet("/api/health", () => Results.Ok(new { status = "ok" }));

        app.Run();
    }
}
