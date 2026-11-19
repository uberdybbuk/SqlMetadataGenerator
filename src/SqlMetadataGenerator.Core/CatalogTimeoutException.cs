using Microsoft.Data.SqlClient;

namespace SqlMetadataGenerator;

// A catalog read that ran past the command timeout, with the read's name. SqlClient's own message
// says only that something timed out.
public sealed class CatalogTimeoutException(string what, TimeSpan elapsed, SqlException inner)
    : TimeoutException($"Reading {what} timed out after {elapsed.TotalSeconds:0} s.", inner)
{
    public string What { get; } = what;
}
