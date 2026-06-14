using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;

namespace SqlMetadataGenerator;

// Üretilmiş .sql dosyalarını hedef veritabanına uygular.
// Yaklaşım: her dosya GO ile batch'lere bölünür; tüm batch'ler kabaca faz sırasıyla (schemas →
// tables → ...) bir kuyruğa konur. Çok turlu (multi-pass) çalıştırılır: bağımlılık eksikliğinden
// hata veren batch'ler sonraki tura ertelenir. Bir turda hiç ilerleme olmazsa kalanlar gerçek hata
// kabul edilir. Başarılı batch tekrar çalıştırılmaz, dolayısıyla "zaten var" hataları oluşmaz.
// Bu sayede bağımlılık grafiğine gerek kalmadan (karşılıklı FK dâhil) doğru sıra elde edilir.
public sealed class SqlScriptDeployer(string connectionString)
{
    private readonly string _connectionString = connectionString;

    // GO batch ayıracı: tek başına satırda "GO" (opsiyonel boşluk), büyük/küçük harf duyarsız.
    private static readonly Regex GoSeparator =
        new(@"^\s*GO\s*$", RegexOptions.Multiline | RegexOptions.IgnoreCase | RegexOptions.Compiled);

    public sealed class Batch(string filePath, string sql)
    {
        public string FilePath { get; } = filePath;
        public string Sql { get; } = sql;
        public string? LastError { get; set; }
    }

    public sealed record DeployReport(int Total, int Succeeded, int Rounds, IReadOnlyList<Batch> Failed);

    // onProgress: (tamamlanan, toplam, tur).
    public async Task<DeployReport> DeployAsync(
        string databaseRoot, Action<int, int, int>? onProgress = null, CancellationToken ct = default)
    {
        var batches = CollectBatches(databaseRoot);
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync(ct);

        return await RunPassesAsync(batches, async batch =>
        {
            try
            {
                await using var cmd = new SqlCommand(batch.Sql, conn) { CommandTimeout = 0 };
                await cmd.ExecuteNonQueryAsync(ct);
                return null;
            }
            catch (SqlException ex)
            {
                return ex.Message;
            }
        }, onProgress);
    }

    // Çok turlu retry döngüsü. tryExecute başarılıysa null, hata varsa mesaj döner.
    // SqlConnection'dan bağımsızdır (test edilebilir): sıra mantığı buradadır.
    internal static async Task<DeployReport> RunPassesAsync(
        List<Batch> batches, Func<Batch, Task<string?>> tryExecute, Action<int, int, int>? onProgress = null)
    {
        int total = batches.Count;
        onProgress?.Invoke(0, total, 0);

        var pending = batches;
        int succeeded = 0;
        int round = 0;

        while (pending.Count > 0)
        {
            round++;
            var stillFailing = new List<Batch>();
            int successThisRound = 0;

            foreach (var batch in pending)
            {
                string? err = await tryExecute(batch);
                if (err is null)
                {
                    succeeded++;
                    successThisRound++;
                    onProgress?.Invoke(succeeded, total, round);
                }
                else
                {
                    batch.LastError = err;
                    stillFailing.Add(batch);
                }
            }

            // İlerleme yoksa kalanlar bağımlılıkla çözülemez (gerçek hata).
            if (successThisRound == 0)
            {
                break;
            }

            pending = stillFailing;
        }

        return new DeployReport(total, succeeded, round, pending);
    }

    // Tüm .sql dosyalarını faz sırasıyla toplar ve GO ile batch'lere böler.
    private static List<Batch> CollectBatches(string databaseRoot)
    {
        var files = Directory
            .EnumerateFiles(databaseRoot, "*.sql", SearchOption.AllDirectories)
            .Select(path => (Path: path, Relative: Path.GetRelativePath(databaseRoot, path)))
            .OrderBy(f => PhaseOrder(f.Relative))
            .ThenBy(f => f.Relative, StringComparer.OrdinalIgnoreCase)
            .ToList();

        var batches = new List<Batch>();
        foreach (var (path, _) in files)
        {
            string content = File.ReadAllText(path);
            foreach (var sql in SplitBatches(content))
            {
                batches.Add(new Batch(path, sql));
            }
        }
        return batches;
    }

    // Faz önceliği: bağımlı nesneler sonra gelsin (yalnızca ilk tur verimliliği için).
    private static int PhaseOrder(string relativePath)
    {
        string p = relativePath.Replace('\\', '/');
        string[] order =
        [
            "Security/Schemas",
            "Programmability/Types",
            "Programmability/Sequences",
            "Tables",
            "Views",
            "Programmability/Functions",
            "Programmability/Stored Procedures",
            "Programmability/Triggers",
            "Synonyms",
        ];

        for (int i = 0; i < order.Length; i++)
        {
            if (p.StartsWith(order[i], StringComparison.OrdinalIgnoreCase))
            {
                return i;
            }
        }

        return 99;
    }

    // Script'i GO batch ayıraçlarından böler (tek başına satırda GO, opsiyonel boşluk).
    internal static IEnumerable<string> SplitBatches(string script)
    {
        foreach (var part in GoSeparator.Split(script))
        {
            string trimmed = part.Trim();
            if (trimmed.Length > 0)
            {
                yield return trimmed;
            }
        }
    }
}
