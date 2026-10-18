namespace SqlMetadataGenerator.Providers;

// Quoting for PostgreSQL.
//
// Unlike SQL Server, where an unquoted identifier keeps its case, PostgreSQL folds an unquoted
// identifier to lower case. A table created as "DocType" can therefore only be reached as
// "DocType" — quoted. So everything is quoted here, always: the cost is a noisier statement,
// and the alternative is a tool that cannot open a mixed-case table.
public static class PgIdentifier
{
    public static string Quote(string name) => "\"" + name.Replace("\"", "\"\"") + "\"";

    public static string Qualify(string schema, string name) => Quote(schema) + "." + Quote(name);
}
