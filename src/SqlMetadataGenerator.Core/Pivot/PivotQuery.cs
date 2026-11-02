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

    // With column fields every result row is one CELL of the matrix, not one line of it, so the
    // same thousand would cut a modest cross-tab in half. The screen still shows one line per row
    // group; it is the cells behind them that this allows more of.
    public const int MaxCells = 10000;

    // The result's columns come in a fixed order the screen relies on: row fields, column fields,
    // measures, then one GROUPING flag per row field and per column field.
    public sealed record Built(string Sql, List<string> Headers, int RowFieldCount, int ColumnFieldCount, int MeasureCount, int Limit);

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
        var rowBy = new List<string>();
        var columnBy = new List<string>();

        foreach (var (fields, target) in new[] { (spec.Rows, rowBy), (spec.Columns, columnBy) })
        {
            foreach (var field in fields)
            {
                var column = Resolve(columns, field.Column);
                string expression = GroupExpression(provider, column, field.Grain);
                target.Add(expression);
                selects.Add($"{expression} AS {Alias(provider, Header(field))}");
                headers.Add(Header(field));
            }
        }

        foreach (var measure in spec.Values)
        {
            selects.Add($"{MeasureExpression(provider, columns, measure)} AS {Alias(provider, Header(measure))}");
            headers.Add(Header(measure));
        }

        var groupBy = rowBy.Concat(columnBy).ToList();

        // One GROUPING flag per field. It is what tells a subtotal row apart from a group whose
        // value genuinely is NULL — without it the two are indistinguishable in the result.
        if (spec.Totals)
        {
            for (int i = 0; i < groupBy.Count; i++)
            {
                selects.Add($"GROUPING({groupBy[i]}) AS {Alias(provider, "__level" + i)}");
                headers.Add("__level" + i);
            }
        }

        int limit = Math.Clamp(spec.Limit, 1, spec.Columns.Count > 0 ? MaxCells : MaxLimit);

        var sql = new StringBuilder();
        sql.Append("SELECT ");
        if (provider == DatabaseProvider.SqlServer)
        {
            sql.Append(CultureInfo.InvariantCulture, $"TOP {limit} ");
        }
        sql.AppendLine();
        sql.AppendLine("    " + string.Join(",\n    ", selects));
        sql.AppendLine($"FROM {Qualify(provider, shape.Schema, shape.Name)}");

        var conditions = new List<string>();
        if (!string.IsNullOrWhiteSpace(spec.Where))
        {
            conditions.Add($"({spec.Where})");
        }
        foreach (var filter in spec.Filters)
        {
            if (FilterCondition(provider, Resolve(columns, filter.Column), filter) is { } condition)
            {
                conditions.Add(condition);
            }
        }
        if (conditions.Count > 0)
        {
            sql.AppendLine($"WHERE {string.Join("\n  AND ", conditions)}");
        }

        if (!spec.Totals)
        {
            sql.AppendLine($"GROUP BY {string.Join(", ", groupBy)}");
        }
        else if (columnBy.Count == 0)
        {
            sql.AppendLine($"GROUP BY ROLLUP({string.Join(", ", rowBy)})");
        }
        else
        {
            // ROLLUP over rows and columns together would only total the columns while the rows
            // are fully expanded. A cross-tab needs every combination of the two: each row level
            // with each column level, down to the grand total at () — the row and column margins
            // of the matrix as well as its corner.
            var sets = new List<string>();
            for (int c = columnBy.Count; c >= 0; c--)
            {
                for (int r = rowBy.Count; r >= 0; r--)
                {
                    sets.Add("(" + string.Join(", ", rowBy.Take(r).Concat(columnBy.Take(c))) + ")");
                }
            }
            sql.AppendLine($"GROUP BY GROUPING SETS (\n    {string.Join(",\n    ", sets)}\n)");
        }

        // Total rows FIRST. Excel puts the grand total at the bottom, but the row cap truncates the
        // tail, and the one row that must never be dropped is the total. The screen puts them back
        // where a reader expects them.
        var order = new List<string>();
        if (spec.Totals)
        {
            foreach (string expression in groupBy)
            {
                order.Add($"GROUPING({expression}) DESC");
            }
        }
        order.Add($"{MeasureExpression(provider, columns, spec.Values[0])} DESC");
        sql.AppendLine($"ORDER BY {string.Join(", ", order)}");

        if (provider == DatabaseProvider.Postgres)
        {
            sql.AppendLine(CultureInfo.InvariantCulture, $"LIMIT {limit}");
        }

        return new Built(sql.ToString().TrimEnd() + ";", headers, spec.Rows.Count, spec.Columns.Count, spec.Values.Count, limit);
    }

    // A filter's values arrive as text and are written into the statement as literals, so each one
    // is checked against the column's type first: a number has to parse as one, and anything else
    // becomes a quoted string with its quotes doubled. Dates are refused. Their values come back
    // from the grid in ISO form with seven fractional digits, which a SQL Server datetime column
    // cannot convert, and a list of individual timestamps is not a filter anyone wants; a date
    // range belongs in the WHERE.
    //
    // Null when the filter excludes nothing, which is what an untouched filter field is.
    private static string? FilterCondition(DatabaseProvider provider, ColumnSummary column, PivotFilter filter)
    {
        if (IsDate(column.TypeName))
        {
            throw new InvalidOperationException($"'{column.Name}' is a date; filter it with the WHERE instead.");
        }
        if (filter.Values.Count == 0)
        {
            if (filter.Exclude)
            {
                return null;
            }
            throw new InvalidOperationException($"The filter on '{column.Name}' has no values ticked.");
        }

        string quoted = Quote(provider, column.Name);
        bool withNull = filter.Values.Contains(null);
        var literals = filter.Values.OfType<string>().Select(v => FilterLiteral(provider, column, v)).ToList();
        string list = literals.Count > 0 ? $"{quoted} {(filter.Exclude ? "NOT IN" : "IN")} ({string.Join(", ", literals)})" : "";

        // NULL never matches IN or NOT IN, in either direction, so it is spelled out every time:
        // otherwise excluding one value would quietly drop every NULL row as well.
        if (filter.Exclude)
        {
            string nulls = withNull ? $"{quoted} IS NOT NULL" : $"{quoted} IS NULL";
            return literals.Count == 0 ? nulls : withNull ? $"({nulls} AND {list})" : $"({nulls} OR {list})";
        }

        if (!withNull)
        {
            return list;
        }
        return literals.Count == 0 ? $"{quoted} IS NULL" : $"({list} OR {quoted} IS NULL)";
    }

    private static string FilterLiteral(DatabaseProvider provider, ColumnSummary column, string value)
    {
        string type = column.TypeName.ToLowerInvariant();

        if (type is "bit" or "boolean" or "bool")
        {
            bool flag = value.Trim().ToLowerInvariant() switch
            {
                "true" or "1" => true,
                "false" or "0" => false,
                _ => throw new InvalidOperationException($"'{value}' is not a value of the {column.TypeName} column '{column.Name}'."),
            };
            return provider == DatabaseProvider.Postgres ? (flag ? "TRUE" : "FALSE") : (flag ? "1" : "0");
        }

        // Re-formatted after parsing rather than passed through, so what reaches the statement is
        // the parsed number and never the text that was sent.
        if (IsSummable(type))
        {
            if (decimal.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out decimal number))
            {
                return number.ToString(CultureInfo.InvariantCulture);
            }
            if (type is "float" or "real" or "double precision" or "float8" or "float4"
                && double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out double wide)
                && double.IsFinite(wide))
            {
                return wide.ToString("R", CultureInfo.InvariantCulture);
            }
            throw new InvalidOperationException($"'{value}' is not a number, and '{column.Name}' is {column.TypeName}.");
        }

        // PostgreSQL: the E'' form with backslashes doubled too, because with standard_conforming_strings
        // off a plain '' literal treats a backslash as an escape, and a value ending in one could
        // close the string early. E'' reads the same whatever that setting is.
        if (provider == DatabaseProvider.Postgres)
        {
            return $"E'{value.Replace("\\", "\\\\").Replace("'", "''")}'";
        }

        // SQL Server: N'' only for Unicode columns. Comparing a varchar column with an nvarchar
        // literal converts the COLUMN, row by row, and an index on it can no longer be used.
        string escaped = value.Replace("'", "''");
        return type is "varchar" or "char" or "text" ? $"'{escaped}'" : $"N'{escaped}'";
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
