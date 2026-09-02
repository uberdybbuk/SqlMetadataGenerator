using System.Security.Cryptography;
using System.Text;

namespace SqlMetadataGenerator;

// Turns SQL Server object names into file names that are valid, and collision-free, on every platform.
// Why this is needed:
// - Path.GetInvalidFileNameChars is platform-dependent (on macOS/Linux it blocks
// almost nothing), so we keep a fixed set covering every platform's invalid characters.
// - Windows forbids reserved names such as CON/PRN/NUL/COM1... and names ending in a dot or a space.
// - After sanitising, two different SQL objects can land on the same name (e.g. "A/B" and "A_B"); and
// because the macOS/Windows file systems are case-insensitive, "Order" and "order" collide too.
// A short hash of the original name is appended in that case, which guarantees uniqueness.
// The file name is only a label; nothing is lost, because the real object name is preserved inside the script.
public sealed class SafeFileName
{
    // The characters we treat as forbidden on every platform (the Windows set is the widest).
    private static readonly char[] InvalidChars =
        ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

    // Windows reserved device names (extension-independent, case-insensitive).
    private static readonly HashSet<string> ReservedNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL", "CLOCK$",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    };

    // A safe upper bound that leaves room for the .sql extension and a possible "__<hash>" suffix.
    private const int MaxBaseLength = 200;

    // Tracks the file names handed out (without extension), case-insensitively, to resolve collisions.
    private readonly HashSet<string> _used = new(StringComparer.OrdinalIgnoreCase);

    // Produces a safe, unique, extension-less file name for the given raw object name (e.g. "dbo.MyTable")
    // within this scope, and reserves it for later calls.
    public string Reserve(string rawName)
    {
        string safe = MakeSafe(rawName);

        if (_used.Add(safe))
        {
            return safe;
        }

        // Collision: disambiguate with a short hash of the original name (deterministic).
        string hashed = Append(safe, ShortHash(rawName));
        if (_used.Add(hashed))
        {
            return hashed;
        }

        // Extremely rare: when the hash collides too, uniquify with an increasing counter.
        for (int i = 2; ; i++)
        {
            string candidate = Append(safe, ShortHash(rawName) + "_" + i);
            if (_used.Add(candidate))
            {
                return candidate;
            }
        }
    }

    // Reduces a name to a valid file name (no collision handling).
    public static string MakeSafe(string rawName)
    {
        var sb = new StringBuilder(rawName.Length);
        foreach (char c in rawName)
        {
            if (c < 0x20 || Array.IndexOf(InvalidChars, c) >= 0)
            {
                sb.Append('_');
            }
            else
            {
                sb.Append(c);
            }
        }

        // Windows: trailing dots and spaces are forbidden.
        string result = sb.ToString().TrimEnd('.', ' ');

        if (result.Length == 0)
        {
            result = "_";
        }

        // Prefix a reserved device name with an underscore to avoid the clash.
        if (ReservedNames.Contains(result))
        {
            result = "_" + result;
        }

        if (result.Length > MaxBaseLength)
        {
            result = result[..MaxBaseLength].TrimEnd('.', ' ');
        }

        return result;
    }

    private static string Append(string baseName, string suffix) => $"{baseName}__{suffix}";

    // A deterministic hash, short enough to resolve collisions (8 hex).
    private static string ShortHash(string value)
    {
        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return Convert.ToHexString(hash, 0, 4).ToLowerInvariant();
    }
}
