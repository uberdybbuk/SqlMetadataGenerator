using System.Globalization;
using System.Text;
using SqlMetadataGenerator.Exploration;
using SqlMetadataGenerator.Providers;

namespace SqlMetadataGenerator.Pivot;

// Builds the GROUP BY behind the pivot screen.
//
// The pivot is computed by the DATABASE, never over the rows already on screen. The grid holds at
// most a thousand rows because the server caps it there, and a SUM over a capped sample of a large
// table is a wrong number shown with complete confidence. Grouping server-side also makes the
// result small by construction: a summary has as many rows as it has groups.
//
// Every identifier is looked up in the table's own shape before it is quoted, so nothing the
// caller sends is ever pasted into the statement as a name. The only free text is the WHERE, which
// goes through WhereClauseGuard exactly as it does everywhere else.
public static class PivotQuery
{
    // A guard against a GROUP BY over something like an identity column, which would return a
    // group per row. The cap is applied in SQL so the rows never leave the server.
    public const int MaxLimit = 1000;

    public sealed record Built(string Sql, List<string> Headers, int RowFieldCount, int MeasureCount);

    public static Built Build(DatabaseProvider provider, TableShape shape, PivotSpec spec)
    {
        if (spec.Rows.Count == 0)
        {
            throw new InvalidOperationException("A pivot needs at least one row field.");
        }
        if (spec.Values.Count == 0)
        {
            throw new InvalidOperationException("A pivot needs at least one value.");
        }

        var columns = shape.Columns.ToDictionary(c => c.Name, StringComparer.OrdinalIgnoreCase);
        var headers = new List<string>();
        var selects = new List<string>();
        var groupBy = new List<string>();

        foreach (var field in spec.Rows)
        {
            var column = Resolve(columns, field.Column);
            string expression = GroupExpression(provider, column, field.Grain);
            groupBy.Add(expression);
            selects.Add($"{expression} AS {Alias(provider, Header(field))}");
            headers.Add(Header(field));
        }

        foreach (var measure in spec.Values)
        {
            selects.Add($"{MeasureExpression(provider, columns, measure)} AS {Alias(provider, Header(measure))}");
            headers.Add(Header(measure));
        }

        // One GROUPING flag per row field. It is what tells a subtotal row apart from a group whose
        // value genuinely is NULL — without it the two are indistinguishable in the result.
        if (spec.Totals)
        {
            for (int i = 0; i < spec.Rows.Count; i++)
            {
                selects.Add($"GROUPING({groupBy[i]}) AS {Alias(provider, "__level" + i)}");
                headers.Add("__level" + i);
            }
        }

        var sql = new StringBuilder();
        sql.Append("SELECT ");
        if (provider == DatabaseProvider.SqlServer)
        {
            sql.Append(CultureInfo.InvariantCulture, $"TOP {Math.Clamp(spec.Limit, 1, MaxLimit)} ");
        }
        sql.AppendLine();
        sql.AppendLine("    " + string.Join(",\n    ", selects));
        sql.AppendLine($"FROM {Qualify(provider, shape.Schema, shape.Name)}");

        if (!string.IsNullOrWhiteSpace(spec.Where))
        {
            sql.AppendLine($"WHERE ({spec.Where})");
        }

        sql.AppendLine(spec.Totals
            ? $"GROUP BY ROLLUP({string.Join(", ", groupBy)})"
            : $"GROUP BY {string.Join(", ", groupBy)}");

        // Total rows FIRST. Excel puts the grand total at the bottom, but the row cap truncates the
        // tail, and the one row that must never be dropped is the total. The screen puts them back
        // where a reader expects them.
        var order = new List<string>();
        if (spec.Totals)
        {
            for (int i = 0; i < spec.Rows.Count; i++)
            {
                order.Add($"GROUPING({groupBy[i]}) DESC");
            }
        }
        order.Add($"{MeasureExpression(provider, columns, spec.Values[0])} DESC");
        sql.AppendLine($"ORDER BY {string.Join(", ", order)}");

        if (provider == DatabaseProvider.Postgres)
        {
            sql.AppendLine($"LIMIT {Math.Clamp(spec.Limit, 1, MaxLimit)}");
        }

        return new Built(sql.ToString().TrimEnd() + ";", headers, spec.Rows.Count, spec.Values.Count);
    }

    private static ColumnSummary Resolve(Dictionary<string, ColumnSummary> columns, string name) =>
        columns.TryGetValue(name, out var column)
            ? column
            : throw new InvalidOperationException($"No column named '{name}' in this table.");

    private static string Header(PivotField field) =>
        field.Grain == DateGrain.None ? field.Column : $"{field.Column} ({field.Grain.ToString().ToLowerInvariant()})";

    private static string Header(PivotMeasure measure) => measure.Aggregate switch
    {
        Aggregate.Count => "Count",
        Aggregate.CountDistinct => $"Distinct {measure.Column}",
        Aggregate.Sum => $"Sum of {measure.Column}",
        Aggregate.Avg => $"Avg of {measure.Column}",
        Aggregate.Min => $"Min of {measure.Column}",
        Aggregate.Max => $"Max of {measure.Column}",
        _ => "Value",
    };

    private static string Qualify(DatabaseProvider provider, string schema, string name) =>
        provider == DatabaseProvider.Postgres
            ? PgIdentifier.Qualify(schema, name)
            : $"{SqlIdentifier.Quote(schema)}.{SqlIdentifier.Quote(name)}";

    private static string Quote(DatabaseProvider provider, string name) =>
        provider == DatabaseProvider.Postgres ? PgIdentifier.Quote(name) : SqlIdentifier.Quote(name);

    // An alias always gets quoted, because it carries spaces and parentheses by design.
    private static string Alias(DatabaseProvider provider, string name) =>
        provider == DatabaseProvider.Postgres ? PgIdentifier.Quote(name) : $"[{name.Replace("]", "]]")}]";

    private static string GroupExpression(DatabaseProvider provider, ColumnSummary column, DateGrain grain)
    {
        string quoted = Quote(provider, column.Name);
        if (grain == DateGrain.None)
        {
            return quoted;
        }

        if (!IsDate(column.TypeName))
        {
            throw new InvalidOperationException($"'{column.Name}' is {column.TypeName}; a date period needs a date column.");
        }

        if (provider == DatabaseProvider.Postgres)
        {
            string unit = grain switch
            {
                DateGrain.Year => "year",
                DateGrain.Quarter => "quarter",
                DateGrain.Month => "month",
                _ => "day",
            };
            return $"date_trunc('{unit}', {quoted})::date";
        }

        return grain switch
        {
            DateGrain.Year => $"DATEFROMPARTS(YEAR({quoted}), 1, 1)",
            DateGrain.Quarter => $"DATEFROMPARTS(YEAR({quoted}), (DATEPART(quarter, {quoted}) - 1) * 3 + 1, 1)",
            DateGrain.Month => $"DATEFROMPARTS(YEAR({quoted}), MONTH({quoted}), 1)",
            _ => $"CAST({quoted} AS date)",
        };
    }

    private static string MeasureExpression(DatabaseProvider provider, Dictionary<string, ColumnSummary> columns, PivotMeasure measure)
    {
        if (measure.Aggregate == Aggregate.Count)
        {
            return "COUNT(*)";
        }

        var column = Resolve(columns, measure.Column ?? throw new InvalidOperationException("This aggregate needs a column."));
        string quoted = Quote(provider, column.Name);

        return measure.Aggregate switch
        {
            Aggregate.CountDistinct => $"COUNT(DISTINCT {quoted})",
            Aggregate.Min => $"MIN({quoted})",
            Aggregate.Max => $"MAX({quoted})",
            Aggregate.Sum => $"SUM({quoted})",
            // AVG over an integer column does INTEGER division on SQL Server: the average of 1 and
            // 2 comes back as 1. PostgreSQL already answers in numeric, so only one side needs the
            // cast, and only for integral types.
            Aggregate.Avg when provider == DatabaseProvider.SqlServer && IsIntegral(column.TypeName) =>
                $"AVG(CAST({quoted} AS float))",
            Aggregate.Avg => $"AVG({quoted})",
            _ => throw new InvalidOperationException($"Unknown aggregate '{measure.Aggregate}'."),
        };
    }

    private static bool IsDate(string typeName) => typeName.ToLowerInvariant() is
        "date" or "datetime" or "datetime2" or "smalldatetime" or "datetimeoffset" or
        "timestamp" or "timestamptz" or "timestamp without time zone" or "timestamp with time zone";

    private static bool IsIntegral(string typeName) => typeName.ToLowerInvariant() is
        "tinyint" or "smallint" or "int" or "integer" or "bigint";

    // Which aggregates make sense for a column, so the screen never offers SUM over a name.
    public static bool IsSummable(string typeName) => typeName.ToLowerInvariant() is
        "tinyint" or "smallint" or "int" or "integer" or "bigint" or "decimal" or "numeric" or
        "money" or "smallmoney" or "float" or "real" or "double precision" or "float8" or "float4";
}
