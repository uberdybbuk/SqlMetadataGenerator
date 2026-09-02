namespace SqlMetadataGenerator.Exploration;

// Kullanıcının girdiği WHERE ifadesi için hafif bir güvenlik süzgeci.
//
// Asıl koruma bu DEĞİL — asıl koruma salt-okunur bir SQL login'i kullanmaktır; ifade
// zaten kullanıcının kendi yetkisiyle çalışır. Buradaki amaç, tek ifade beklenen yere
// yanlışlıkla ya da kasten ikinci bir cümle sokulmasını engellemek.
//
// Önce string literal'leri ve tırnaklı tanımlayıcıları atlarız, sonra geri kalanda
// yasak belirteç ararız. Bu sayede WHERE Note LIKE '%--%' gibi meşru ifadeler reddedilmez.
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

    // i, açılış karakterinin üzerindeyken çağrılır ve kapanış karakterinin üzerinde bırakılır.
    // İkiye katlanmış kapanış karakteri ('' veya ]]) kaçış sayılır ve atlanır.
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
