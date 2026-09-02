using Microsoft.Data.SqlClient;

namespace SqlMetadataGenerator;

// This tool only READS the database. Every query runs under READ UNCOMMITTED:
// browsing a live server must take no shared locks and must never hold up
// writers. Catalog queries included — a single query skipping this is enough
// to break the tool's claim that it puts no load on the server.
//
// The isolation level could also be set with a separate command once the
// connection is open, but that would cost an extra round trip per connection
// (the setting resets when connections come from the pool). Prefixing the text is free.
public static class ReadOnlyCommand
{
    public const string IsolationPrefix = "SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;\n";

    public static SqlCommand Create(SqlConnection connection, string sql) =>
        new(IsolationPrefix + sql, connection);
}
