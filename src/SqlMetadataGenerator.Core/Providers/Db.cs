using System.Data.Common;
using Microsoft.Data.SqlClient;
using Npgsql;

namespace SqlMetadataGenerator.Providers;

// Opening a connection and starting a read, for either engine.
//
// Everything above this works in DbConnection and DbCommand, which ADO.NET already abstracts.
// What it does NOT abstract is the read-only discipline this tool promises, and that differs:
// see ReadOnly below.
public static class Db
{
    public static DbConnection Create(DatabaseProvider provider, string connectionString) =>
        provider == DatabaseProvider.Postgres
            ? new NpgsqlConnection(connectionString)
            : new SqlConnection(connectionString);

    public static async Task<DbConnection> OpenAsync(
        DatabaseProvider provider, string connectionString, CancellationToken ct)
    {
        var connection = Create(provider, connectionString);
        await connection.OpenAsync(ct);
        return connection;
    }

    // A read that must not get in anyone's way.
    //
    // On SQL Server every statement is prefixed with READ UNCOMMITTED, because the default
    // isolation takes shared locks and browsing a live server must never hold up a writer.
    //
    // PostgreSQL needs no prefix and must not be given one. Its readers never take row locks at
    // all — MVCC gives each statement a snapshot — so the property the prefix buys on SQL Server
    // is already guaranteed. Sending SET TRANSACTION outside a transaction block would only earn
    // a warning on every single query.
    public static DbCommand ReadOnly(DatabaseProvider provider, DbConnection connection, string sql)
    {
        var command = connection.CreateCommand();
        command.CommandText = provider == DatabaseProvider.Postgres
            ? sql
            : ReadOnlyCommand.IsolationPrefix + sql;
        return command;
    }

    // Parameter placeholders differ ("@p" on SQL Server, "$1" or "@p" on Npgsql — Npgsql accepts
    // named parameters, so "@p" works on both and is what this codebase uses).
    public static DbParameter With(this DbCommand command, string name, object? value)
    {
        var p = command.CreateParameter();
        p.ParameterName = name;
        p.Value = value ?? DBNull.Value;
        command.Parameters.Add(p);
        return p;
    }
}
