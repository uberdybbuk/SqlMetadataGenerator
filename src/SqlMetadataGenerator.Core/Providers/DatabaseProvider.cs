namespace SqlMetadataGenerator.Providers;

// Which engine a connection points at.
//
// SQL Server is the default and stays the default: every existing connections.json entry omits
// the field, and an omitted field must keep meaning what it meant before.
public enum DatabaseProvider
{
    SqlServer,
    Postgres,
}

public static class DatabaseProviders
{
    public static DatabaseProvider Parse(string? name) =>
        name?.Trim().ToLowerInvariant() switch
        {
            null or "" or "sqlserver" or "mssql" or "sql" => DatabaseProvider.SqlServer,
            "postgres" or "postgresql" or "pgsql" or "pg" => DatabaseProvider.Postgres,
            _ => throw new InvalidOperationException(
                $"Unknown provider '{name}'. Use 'sqlserver' or 'postgres'."),
        };

    public static string Name(this DatabaseProvider provider) =>
        provider == DatabaseProvider.Postgres ? "postgres" : "sqlserver";

    // The database a server-level query connects to before one has been chosen. Both engines
    // need SOME database to connect to before they can list the others.
    public static string DefaultDatabase(this DatabaseProvider provider) =>
        provider == DatabaseProvider.Postgres ? "postgres" : "master";
}
