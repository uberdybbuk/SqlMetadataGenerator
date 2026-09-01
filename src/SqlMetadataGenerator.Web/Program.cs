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

        // Hangi dosyanın kullanıldığını (veya bulunamadığını) açıkça söyle: sessizce boş
        // bağlantı listesiyle açılmak teşhis edilmesi zor bir durum yaratıyor.
        var log = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Connections");
        if (resolved is null)
        {
            log.LogWarning("'{File}' bulunamadı; bağlantı listesi boş. connections.example.json'ı kopyalayın.", configured);
        }
        else
        {
            log.LogInformation("Bağlantı tanımları: {Path}", resolved);
        }

        app.MapExplorerEndpoints();

        // Production'da SPA'yı wwwroot'tan sun. Fallback şart: /app/demo/Bpm/tables gibi
        // istemci tarafı bir rotada sayfa yenilenince sunucuda o dosya yoktur.
        // Geliştirmede SPA'yı Vite sunar (:5173) ve /api'yi buraya proxy'ler.
        app.UseStaticFiles();
        app.MapFallbackToFile("index.html");

        app.Run();
    }

    // Göreli yol için sırayla: çalışma dizini, content root, sonra content root'tan yukarı.
    // Yukarı arama sayesinde 'dotnet run --project src/...' hangi dizinden çağrılırsa
    // çağrılsın repo kökündeki dosya bulunur.
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
