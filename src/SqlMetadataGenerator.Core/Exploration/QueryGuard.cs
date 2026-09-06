namespace SqlMetadataGenerator.Exploration;

// A guard for the SQL a user types into the editor.
//
// The REAL protection is still the login: this tool is meant to be pointed at a read-only account,
// and a statement runs with whatever rights that account has. The guard exists because the tool
// promises to only read, and a promise the code does not enforce is a promise waiting to be broken
// — a connections.json entry pointing at a privileged login should not turn a typo into a DELETE.
//
// The rule is deliberately narrow rather than clever: one statement, and it has to start with
// SELECT or WITH. Anything that writes, changes the server's state, or hands execution to another
// object is refused by name. A parser would be the thorough answer; a small allow-list of shapes
// is the honest one, and it fails closed.
public static class QueryGuard
{
    public const int MaxLength = 20000;

    // Refused wherever they appear, not only at the start: a CTE body or a subquery is just as
    // capable of writing as the outer statement.
    private static readonly HashSet<string> Forbidden = new(StringComparer.OrdinalIgnoreCase)
    {
        "insert", "update", "delete", "merge", "truncate",
        "create", "alter", "drop", "rename",
        "exec", "execute", "sp_executesql",
        "grant", "revoke", "deny",
        "backup", "restore", "shutdown", "reconfigure", "dbcc", "kill",
        "waitfor", "openrowset", "opendatasource", "openquery", "openxml",
        "bulk", "into",
    };

    private static readonly HashSet<string> Starters = new(StringComparer.OrdinalIgnoreCase)
    {
        "select", "with",
    };

    public static bool TryValidate(string? sql, out string? error)
    {
        error = null;

        if (string.IsNullOrWhiteSpace(sql))
        {
            error = "The query is empty.";
            return false;
        }

        if (sql.Length > MaxLength)
        {
            error = $"The query can be at most {MaxLength} characters.";
            return false;
        }

        // Literals, quoted identifiers and comments are stripped first, so a string containing the
        // word "delete" or a commented-out statement is not mistaken for the real thing.
        if (!TryStrip(sql, out string bare, out error))
        {
            return false;
        }

        var words = Tokenize(bare);
        if (words.Count == 0)
        {
            error = "The query has no statement in it.";
            return false;
        }

        if (!Starters.Contains(words[0]))
        {
            error = $"Only SELECT (or WITH ... SELECT) can be run here; this starts with '{words[0]}'.";
            return false;
        }

        foreach (string word in words)
        {
            if (Forbidden.Contains(word))
            {
                // A column really called "into" is not impossible; brackets get it past the guard,
                // because a quoted identifier is stripped before the words are read.
                error = $"'{word.ToUpperInvariant()}' is not allowed: this window only reads. "
                    + "If that is a column name, write it as [" + word + "].";
                return false;
            }
        }

        // One statement. A trailing semicolon is fine; a second statement after it is not.
        int end = bare.IndexOf(';');
        if (end >= 0 && bare[(end + 1)..].Any(c => !char.IsWhiteSpace(c)))
        {
            error = "Only one statement can be run at a time.";
            return false;
        }

        return true;
    }

    // Replaces every literal, quoted identifier and comment with a space, so what remains is only
    // the code's own words. Returns false when something is left open, which is a syntax error the
    // user should hear about before the server does.
    private static bool TryStrip(string sql, out string bare, out string? error)
    {
        error = null;
        var output = new System.Text.StringBuilder(sql.Length);

        for (int i = 0; i < sql.Length; i++)
        {
            char c = sql[i];

            if (c == '\'' || c == '[' || c == '"')
            {
                char closing = c == '[' ? ']' : c;
                if (!SkipDelimited(sql, ref i, closing))
                {
                    bare = string.Empty;
                    error = $"Unclosed {(c == '[' ? "bracket" : "quote")} ({c}).";
                    return false;
                }
                output.Append(' ');
                continue;
            }

            if (c == '-' && i + 1 < sql.Length && sql[i + 1] == '-')
            {
                while (i < sql.Length && sql[i] != '\n')
                {
                    i++;
                }
                output.Append(' ');
                continue;
            }

            if (c == '/' && i + 1 < sql.Length && sql[i + 1] == '*')
            {
                int close = sql.IndexOf("*/", i + 2, StringComparison.Ordinal);
                if (close < 0)
                {
                    bare = string.Empty;
                    error = "Unclosed comment (/*).";
                    return false;
                }
                i = close + 1;
                output.Append(' ');
                continue;
            }

            output.Append(c);
        }

        bare = output.ToString();
        return true;
    }

    private static List<string> Tokenize(string bare)
    {
        var words = new List<string>();
        int start = -1;
        for (int i = 0; i <= bare.Length; i++)
        {
            bool part = i < bare.Length && (char.IsLetterOrDigit(bare[i]) || bare[i] == '_' || bare[i] == '@' || bare[i] == '#');
            if (part && start < 0)
            {
                start = i;
            }
            else if (!part && start >= 0)
            {
                words.Add(bare[start..i]);
                start = -1;
            }
        }

        return words;
    }

    // Called with i on the opening character, and left on the closing one. A doubled closing
    // character ('' or ]]) is an escape, not the end.
    private static bool SkipDelimited(string text, ref int i, char closing)
    {
        for (int j = i + 1; j < text.Length; j++)
        {
            if (text[j] != closing)
            {
                continue;
            }

            if (j + 1 < text.Length && text[j + 1] == closing)
            {
                j++;
                continue;
            }

            i = j;
            return true;
        }

        return false;
    }
}
