using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;

namespace SqlMetadataGenerator;

// Applies the generated .sql files to the target database.
// Approach: every file is split into batches at GO; all batches go into a queue in rough phase order
// (schemas → tables → ...). It runs in multiple passes: batches that fail on a missing dependency are
// deferred to the next pass. When a pass makes no progress at all, whatever is left counts as a real
// error. A successful batch is never re-run, so "already exists" errors cannot happen.
// This gets the order right without building a dependency graph (mutual foreign keys included).
public sealed class SqlScriptDeployer(string connectionString)
{
    private readonly string _connectionString = connectionString;

    // The GO batch separator: "GO" alone on a line (optional whitespace), case-insensitive.
    private static readonly Regex GoSeparator =
        new(@"^\s*GO\s*$", RegexOptions.Multiline | RegexOptions.IgnoreCase | RegexOptions.Compiled);

    public sealed class Batch(string filePath, string sql)
    {
        public string FilePath { get; } = filePath;
        public string Sql { get; } = sql;
        public string? LastError { get; set; }
    }

    public sealed record DeployReport(int Total, int Succeeded, int Rounds, IReadOnlyList<Batch> Failed);

    // onProgress: (completed, total, pass).
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

    // The multi-pass retry loop. tryExecute returns null on success, or the message on failure.
    // Independent of SqlConnection (so it is testable): the ordering logic lives here.
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

            // No progress means the rest cannot be resolved by dependencies (a real error).
            if (successThisRound == 0)
            {
                break;
            }

            pending = stillFailing;
        }

        return new DeployReport(total, succeeded, round, pending);
    }

    // Collects every .sql file in phase order and splits it into batches at GO.
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

    // Phase priority: dependent objects come later (only for first-pass efficiency).
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

    // Splits the script at GO batch separators (GO alone on a line, optional whitespace).
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
