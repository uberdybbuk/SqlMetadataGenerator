using System.Diagnostics;
using System.IO.Compression;

namespace SqlMetadataGenerator.Scripting;

// Packs a bundle for download.
//
// 7-Zip first, at -mx=9. LZMA2 at maximum beats deflate by a wide margin on SQL text — the files
// in one database repeat the same keywords, type names and column names thousands of times, which
// is exactly what a large dictionary is for.
//
// It is an EXTERNAL BINARY though, and this tool has never needed one. So the fallback is real,
// not decorative: with no 7z on the host the download is a .zip at SmallestSize, and the caller is
// told which one it got rather than the request failing over a compression ratio.
public static class ScriptArchive
{
    // 7zz is the current official build, 7z the package-manager one, 7za the standalone.
    private static readonly string[] Candidates = ["7zz", "7z", "7za"];

    public sealed record Package(byte[] Bytes, string Extension, string ContentType, string Method);

    public static Task<Package> PackAsync(
        IReadOnlyList<(string Path, string Content)> files, CancellationToken ct = default) =>
        PackAsync(files, FindTool(), ct);

    // The packer is a parameter so the zip path can be exercised on a host that HAS 7-Zip: pass
    // null and the fallback runs. Without a seam the fallback is code nobody has ever executed.
    public static async Task<Package> PackAsync(
        IReadOnlyList<(string Path, string Content)> files,
        string? tool,
        CancellationToken ct = default)
    {
        if (tool is not null)
        {
            try
            {
                return await SevenZipAsync(tool, files, ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // A missing codec, a read-only temp directory, a binary that is not what its name
                // says. None of that is worth failing a download over.
                Console.Error.WriteLine($"7-Zip packing failed ({ex.Message}); falling back to zip.");
            }
        }

        return Zip(files);
    }

    private static string? FindTool()
    {
        string[] roots = OperatingSystem.IsWindows()
            ? []
            // A GUI-launched process on macOS does not inherit a login shell's PATH, so the usual
            // install locations are checked directly as well.
            : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

        foreach (string name in Candidates)
        {
            foreach (string root in roots)
            {
                string full = Path.Combine(root, name);
                if (File.Exists(full))
                {
                    return full;
                }
            }

            // And on PATH, which is how it will be found on Windows and in a container.
            string? onPath = (Environment.GetEnvironmentVariable("PATH") ?? string.Empty)
                .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
                .Select(dir => Path.Combine(dir, OperatingSystem.IsWindows() ? name + ".exe" : name))
                .FirstOrDefault(File.Exists);
            if (onPath is not null)
            {
                return onPath;
            }
        }

        return null;
    }

    private static async Task<Package> SevenZipAsync(
        string tool, IReadOnlyList<(string Path, string Content)> files, CancellationToken ct)
    {
        // The CLI archives a directory, so the bundle is laid out on disk first. Deleted in the
        // finally: a download that is cancelled halfway must not leave a database's DDL behind.
        string work = Path.Combine(Path.GetTempPath(), "sqlmeta-" + Guid.NewGuid().ToString("n"));
        string tree = Path.Combine(work, "tree");
        string archive = Path.Combine(work, "bundle.7z");

        try
        {
            foreach (var (path, content) in files)
            {
                string full = Path.Combine(tree, path.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(full)!);
                await File.WriteAllTextAsync(full, content, ct);
            }

            // -mx=9 maximum, -m0=LZMA2 explicitly rather than by default, -bso0/-bse0 to keep the
            // tool's own chatter out of the server's console.
            var start = new ProcessStartInfo(tool)
            {
                WorkingDirectory = tree,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            foreach (string arg in new[] { "a", "-t7z", "-m0=lzma2", "-mx=9", "-bso0", "-bse0", archive, "." })
            {
                start.ArgumentList.Add(arg);
            }

            using var process = Process.Start(start)
                ?? throw new InvalidOperationException($"Could not start '{tool}'.");
            string errors = await process.StandardError.ReadToEndAsync(ct);
            await process.WaitForExitAsync(ct);

            if (process.ExitCode != 0 || !File.Exists(archive))
            {
                throw new InvalidOperationException(
                    $"{Path.GetFileName(tool)} exited with {process.ExitCode}. {errors}".Trim());
            }

            return new Package(
                await File.ReadAllBytesAsync(archive, ct),
                ".7z",
                "application/x-7z-compressed",
                $"7-Zip (LZMA2, -mx=9) via {Path.GetFileName(tool)}");
        }
        finally
        {
            try
            {
                if (Directory.Exists(work))
                {
                    Directory.Delete(work, recursive: true);
                }
            }
            catch (IOException)
            {
                // A temp directory that will not go is the operating system's problem, not a
                // reason to turn a finished download into an error.
            }
        }
    }

    private static Package Zip(IReadOnlyList<(string Path, string Content)> files)
    {
        var buffer = new MemoryStream();
        using (var zip = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (path, content) in files)
            {
                var entry = zip.CreateEntry(path, CompressionLevel.SmallestSize);
                using var writer = new StreamWriter(entry.Open());
                writer.Write(content);
            }
        }

        return new Package(buffer.ToArray(), ".zip", "application/zip", "deflate (no 7-Zip on this host)");
    }
}
