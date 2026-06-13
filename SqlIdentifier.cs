namespace SqlMetadataGenerator;

/// <summary>
/// SQL Server tanımlayıcılarını yalnızca gerektiğinde köşeli parantezle sarar.
/// SSMS her zaman [..] kullanır; biz yalnızca gerçekten gerekli olduğunda kullanırız
/// (rezerve kelime, düzenli tanımlayıcı kurallarına uymayan ad, vb.) — aksi hâlde çıplak yazarız.
/// </summary>
public static class SqlIdentifier
{
    // Microsoft "Reserved Keywords (Transact-SQL)" resmi listesi.
    private static readonly HashSet<string> Reserved = new(StringComparer.OrdinalIgnoreCase)
    {
        "ADD", "ALL", "ALTER", "AND", "ANY", "AS", "ASC", "AUTHORIZATION", "BACKUP", "BEGIN",
        "BETWEEN", "BREAK", "BROWSE", "BULK", "BY", "CASCADE", "CASE", "CHECK", "CHECKPOINT",
        "CLOSE", "CLUSTERED", "COALESCE", "COLLATE", "COLUMN", "COMMIT", "COMPUTE", "CONSTRAINT",
        "CONTAINS", "CONTAINSTABLE", "CONTINUE", "CONVERT", "CREATE", "CROSS", "CURRENT",
        "CURRENT_DATE", "CURRENT_TIME", "CURRENT_TIMESTAMP", "CURRENT_USER", "CURSOR", "DATABASE",
        "DBCC", "DEALLOCATE", "DECLARE", "DEFAULT", "DELETE", "DENY", "DESC", "DISK", "DISTINCT",
        "DISTRIBUTED", "DOUBLE", "DROP", "DUMP", "ELSE", "END", "ERRLVL", "ESCAPE", "EXCEPT",
        "EXEC", "EXECUTE", "EXISTS", "EXIT", "EXTERNAL", "FETCH", "FILE", "FILLFACTOR", "FOR",
        "FOREIGN", "FREETEXT", "FREETEXTTABLE", "FROM", "FULL", "FUNCTION", "GOTO", "GRANT",
        "GROUP", "HAVING", "HOLDLOCK", "IDENTITY", "IDENTITY_INSERT", "IDENTITYCOL", "IF", "IN",
        "INDEX", "INNER", "INSERT", "INTERSECT", "INTO", "IS", "JOIN", "KEY", "KILL", "LEFT",
        "LIKE", "LINENO", "LOAD", "MERGE", "NATIONAL", "NOCHECK", "NONCLUSTERED", "NOT", "NULL",
        "NULLIF", "OF", "OFF", "OFFSETS", "ON", "OPEN", "OPENDATASOURCE", "OPENQUERY",
        "OPENROWSET", "OPENXML", "OPTION", "OR", "ORDER", "OUTER", "OVER", "PERCENT", "PIVOT",
        "PLAN", "PRECISION", "PRIMARY", "PRINT", "PROC", "PROCEDURE", "PUBLIC", "RAISERROR",
        "READ", "READTEXT", "RECONFIGURE", "REFERENCES", "REPLICATION", "RESTORE", "RESTRICT",
        "RETURN", "REVERT", "REVOKE", "RIGHT", "ROLLBACK", "ROWCOUNT", "ROWGUIDCOL", "RULE",
        "SAVE", "SCHEMA", "SECURITYAUDIT", "SELECT", "SEMANTICKEYPHRASETABLE",
        "SEMANTICSIMILARITYDETAILSTABLE", "SEMANTICSIMILARITYTABLE", "SESSION_USER", "SET",
        "SETUSER", "SHUTDOWN", "SOME", "STATISTICS", "SYSTEM_USER", "TABLE", "TABLESAMPLE",
        "TEXTSIZE", "THEN", "TO", "TOP", "TRAN", "TRANSACTION", "TRIGGER", "TRUNCATE",
        "TRY_CONVERT", "TSEQUAL", "UNION", "UNIQUE", "UNPIVOT", "UPDATE", "UPDATETEXT", "USE",
        "USER", "VALUES", "VARYING", "VIEW", "WAITFOR", "WHEN", "WHERE", "WHILE", "WITH",
        "WRITETEXT",
    };

    /// <summary>Tanımlayıcıyı gerekiyorsa [..] ile sarar, gerekmiyorsa olduğu gibi döndürür.</summary>
    public static string Quote(string name) =>
        NeedsQuoting(name) ? $"[{name.Replace("]", "]]")}]" : name;

    private static bool NeedsQuoting(string name)
    {
        if (string.IsNullOrEmpty(name))
            return true;
        if (Reserved.Contains(name))
            return true;
        return !IsRegularIdentifier(name);
    }

    /// <summary>
    /// SQL Server "düzenli tanımlayıcı" kuralları: ilk karakter harf (Unicode) veya '_';
    /// sonraki karakterler harf, rakam, '_', '@', '$' veya '#'.
    /// '@'/'#' ile başlayanlar (değişken/temp tablo anlamı) güvenlik için tırnaklanır.
    /// </summary>
    private static bool IsRegularIdentifier(string name)
    {
        char first = name[0];
        if (!char.IsLetter(first) && first != '_')
            return false;

        for (int i = 1; i < name.Length; i++)
        {
            char c = name[i];
            if (!char.IsLetterOrDigit(c) && c is not ('_' or '@' or '$' or '#'))
                return false;
        }
        return true;
    }
}
