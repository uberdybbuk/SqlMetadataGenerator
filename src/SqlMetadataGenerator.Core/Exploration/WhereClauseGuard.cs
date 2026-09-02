namespace SqlMetadataGenerator.Exploration;

// A light safety filter for the WHERE expression the user types.
//
// This is NOT the real protection — the real protection is using a read-only SQL login; the
// expression runs with the user's own rights anyway. The goal here is to stop a second statement
// being slipped, by accident or on purpose, into a place that expects a single expression.
//
// String literals and quoted identifiers are skipped first, then forbidden tokens are looked for
// in what remains. That way a legitimate expression like WHERE Note LIKE '%--%' is not rejected.
public static class WhereClauseGuard
{
    public const int MaxLength = 4000;

    public static bool TryValidate(string? where, out string? error)
    {
        error = null;

        if (string.IsNullOrWhiteSpace(where))
        {
            error = "The WHERE expression cannot be empty.";
            return false;
        }

        if (where.Length > MaxLength)
        {
            error = $"The WHERE expression can be at most {MaxLength} characters.";
            return false;
        }

        for (int i = 0; i < where.Length; i++)
        {
            char c = where[i];

            if (c == '\'')
            {
                if (!SkipDelimited(where, ref i, '\'', '\''))
                {
                    error = "Unclosed quote (').";
                    return false;
                }
                continue;
            }

            if (c == '[')
            {
                if (!SkipDelimited(where, ref i, ']', ']'))
                {
                    error = "Unclosed bracket ([).";
                    return false;
                }
                continue;
            }

            if (c == '"')
            {
                if (!SkipDelimited(where, ref i, '"', '"'))
                {
                    error = "Unclosed double quote (\").";
                    return false;
                }
                continue;
            }

            if (c == ';')
            {
                error = "';' is not allowed in a WHERE expression — a single condition is expected.";
                return false;
            }

            if (c == '-' && i + 1 < where.Length && where[i + 1] == '-')
            {
                error = "'--' comments are not allowed in a WHERE expression.";
                return false;
            }

            if (c == '/' && i + 1 < where.Length && where[i + 1] == '*')
            {
                error = "'/*' comments are not allowed in a WHERE expression.";
                return false;
            }

            if (c == '*' && i + 1 < where.Length && where[i + 1] == '/')
            {
                error = "'*/' comments are not allowed in a WHERE expression.";
                return false;
            }
        }

        return true;
    }

    // Called with i on the opening character, and left on the closing character.
    // A doubled closing character ('' or ]]) counts as an escape and is skipped.
    private static bool SkipDelimited(string text, ref int i, char closing, char escapeDouble)
    {
        for (int j = i + 1; j < text.Length; j++)
        {
            if (text[j] != closing)
            {
                continue;
            }

            if (j + 1 < text.Length && text[j + 1] == escapeDouble)
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
