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
        string Q(string name) => Quote(provider, name);

        // A date field's period is computed ONCE, as a named column of the src CTE, and everything
        // after that refers to it by name. Written inline, the same DATEFROMPARTS(...) would be
        // repeated in the SELECT, the GROUP BY, every GROUPING() and the ORDER BY, and the
        // statement on screen would be unreadable. The name has to differ from the table's own
        // columns, since src carries those too.
        var periods = new List<(string Name, string Expression)>();
        var outputs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var rowKeys = new List<Key>();
        var columnKeys = new List<Key>();
        foreach (var (fields, target) in new[] { (spec.Rows, rowKeys), (spec.Columns, columnKeys) })
        {
            foreach (var field in fields)
            {
                var column = Resolve(columns, field.Column);
                string source = column.Name;
                if (field.Grain != DateGrain.None)
                {
                    string expression = PeriodExpression(provider, column, field.Grain);
                    var period = periods.FirstOrDefault(p => p.Expression == expression);
                    if (period.Name is null)
                    {
                        period = (Distinct(Header(field), n => columns.ContainsKey(n) || periods.Any(p => p.Name.Equals(n, StringComparison.OrdinalIgnoreCase))), expression);
                        periods.Add(period);
                    }
                    source = period.Name;
                }
                // Result column names have to be unique: a CTE refuses two columns of one name.
                string name = Distinct(source, outputs.Contains);
                outputs.Add(name);
                target.Add(new Key(source, name));
            }
        }
        var keys = rowKeys.Concat(columnKeys).ToList();

        var measureNames = new List<string>();
        foreach (var measure in spec.Values)
        {
            string name = Distinct(Header(measure), outputs.Contains);
            outputs.Add(name);
            measureNames.Add(name);
        }

        int limit = Math.Clamp(spec.Limit, 1, spec.Columns.Count > 0 ? MaxCells : MaxLimit);
        string table = Qualify(provider, shape.Schema, shape.Name);

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

        // Value filters. Each one is its own GROUP BY ... HAVING over the same rows, down to the
        // filtered field's level, and the pivot keeps only the rows whose group passed. Filtering
        // the ROWS rather than the result is what keeps the totals honest: the grand total then
        // covers exactly the groups on screen, whichever measure is shown, Excel's behaviour. A
        // HAVING on the pivot itself would also be applied to every total row, and the grand total
        // would go on counting the groups it had dropped.
        var filtered = new List<(int Index, PivotMeasure Measure, PivotValueFilter Filter, List<Key> Keys)>();
        foreach (var (fields, axis) in new[] { (spec.Rows, rowKeys), (spec.Columns, columnKeys) })
        {
            for (int i = 0; i < fields.Count; i++)
            {
                if (fields[i].Filter is not { } valueFilter)
                {
                    continue;
                }
                var measure = MeasureAt(spec, valueFilter.Measure, fields[i].Column);
                if (!IsNumericMeasure(columns, measure))
                {
                    throw new InvalidOperationException($"{Header(measure)} is not a number, so '{fields[i].Column}' cannot be filtered by it.");
                }
                filtered.Add((filtered.Count, measure, valueFilter, axis.Take(i + 1).ToList()));
            }
        }

        // The rows the pivot reads: the table, filtered, with each period as a column. Only worth a
        // CTE when there is a period to add, or a value filter that has to read the same rows again.
        bool withSource = periods.Count > 0 || filtered.Count > 0;
        string from = withSource ? "src" : table;
        var ctes = new List<string>();
        if (withSource)
        {
            var src = new StringBuilder();
            // PostgreSQL computes a CTE that is read more than once into a temporary result first:
            // here that would be a copy of the whole table. NOT MATERIALIZED lets it fold src into
            // each query that reads it, as SQL Server always does.
            src.AppendLine(provider == DatabaseProvider.Postgres && filtered.Count > 0 ? "src AS NOT MATERIALIZED (" : "src AS (");
            src.AppendLine("    SELECT " + string.Join(",\n        ", periods.Select(p => $"{p.Expression} AS {Q(p.Name)}").Prepend("*")));
            src.AppendLine($"    FROM {table}");
            if (conditions.Count > 0)
            {
                src.AppendLine($"    WHERE {string.Join("\n      AND ", conditions)}");
            }
            src.Append(')');
            ctes.Add(src.ToString());
            conditions.Clear();
        }

        foreach (var (index, measure, valueFilter, by) in filtered)
        {
            string names = string.Join(", ", by.Select(k => Q(k.Source)));
            ctes.Add(
                $"keep{index} AS (\n    SELECT {names}\n    FROM src\n    GROUP BY {names}\n"
                + $"    HAVING {MeasureExpression(provider, columns, measure)} {Operator(valueFilter.Op)} {valueFilter.Value.ToString(CultureInfo.InvariantCulture)}\n)");
            // NULL is a group like any other in a pivot, so a NULL key has to find its own group
            // too; = alone never matches it.
            var matches = by.Select(k => $"(k.{Q(k.Source)} = src.{Q(k.Source)} OR (k.{Q(k.Source)} IS NULL AND src.{Q(k.Source)} IS NULL))");
            conditions.Add($"EXISTS (SELECT 1 FROM keep{index} AS k WHERE {string.Join(" AND ", matches)})");
        }

        // The grouping itself, with one GROUPING flag per field when there are totals. The flag is
        // what tells a subtotal row apart from a group whose value genuinely is NULL — without it
        // the two are indistinguishable in the result.
        string Level(int i) => Q("__level" + i);
        var selects = keys.Select(k => k.Source.Equals(k.Name, StringComparison.Ordinal) ? Q(k.Source) : $"{Q(k.Source)} AS {Q(k.Name)}").ToList();
        selects.AddRange(spec.Values.Select((m, i) => $"{MeasureExpression(provider, columns, m)} AS {Q(measureNames[i])}"));
        if (spec.Totals)
        {
            selects.AddRange(keys.Select((k, i) => $"GROUPING({Q(k.Source)}) AS {Level(i)}"));
        }

        string groupBy;
        var rowBy = rowKeys.Select(k => Q(k.Source)).ToList();
        var columnBy = columnKeys.Select(k => Q(k.Source)).ToList();
        if (!spec.Totals)
        {
            groupBy = $"GROUP BY {string.Join(", ", rowBy.Concat(columnBy))}";
        }
        else if (columnBy.Count == 0)
        {
            groupBy = $"GROUP BY ROLLUP({string.Join(", ", rowBy)})";
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
            groupBy = $"GROUP BY GROUPING SETS (\n    {string.Join(",\n    ", sets)}\n)";
        }

        // The order, in the result's own column names. Total rows FIRST: Excel puts the grand total
        // at the bottom, but the row cap truncates the tail, and the one row that must never be
        // dropped is the total. The screen puts them back where a reader expects them.
        var order = new List<string>();
        if (spec.Totals)
        {
            order.AddRange(keys.Select((_, i) => $"{Level(i)} DESC"));
        }
        // Then each field's own sort, outermost first. The screen orders the groups itself; this
        // decides which groups survive the row cap, so "smallest first" keeps the smallest.
        // A field's GROUPING flag is __level<n>, rows first, then columns.
        foreach (var (fields, axis, first, otherFirst, otherCount) in new[]
        {
            (spec.Rows, rowKeys, 0, rowKeys.Count, columnKeys.Count),
            (spec.Columns, columnKeys, rowKeys.Count, 0, rowKeys.Count),
        })
        {
            for (int i = 0; i < fields.Count; i++)
            {
                if (fields[i].Sort is not { } sort)
                {
                    continue;
                }
                string direction = sort.Descending ? "DESC" : "ASC";
                if (sort.Measure is not { } index)
                {
                    order.Add($"{Q(axis[i].Name)} {direction}");
                    continue;
                }

                MeasureAt(spec, index, fields[i].Column);
                string value = Q(measureNames[index]);
                if (!spec.Totals)
                {
                    order.Add($"{value} {direction}");
                    continue;
                }
                // A group is ordered by its own total, which sits on the result row for exactly its
                // level: its fields grouped, the next one rolled up, the other axis rolled up
                // entirely. The window carries that number to every row inside the group.
                var exact = new List<string> { $"{Level(first + i)} = 0" };
                if (i + 1 < axis.Count)
                {
                    exact.Add($"{Level(first + i + 1)} = 1");
                }
                if (otherCount > 0)
                {
                    exact.Add($"{Level(otherFirst)} = 1");
                }
                order.Add(
                    $"MAX(CASE WHEN {string.Join(" AND ", exact)} THEN {value} END) "
                    + $"OVER (PARTITION BY {string.Join(", ", axis.Take(i + 1).Select(k => Q(k.Name)))}) {direction}");
            }
        }
        // The last word goes to the first measure, unless a field's sort already ordered by it:
        // SQL Server refuses a column that appears twice in an ORDER BY.
        string fallback = Q(measureNames[0]);
        if (!order.Any(o => o.StartsWith(fallback + " ", StringComparison.Ordinal)))
        {
            order.Add($"{fallback} DESC");
        }

        string top = provider == DatabaseProvider.SqlServer ? string.Create(CultureInfo.InvariantCulture, $"TOP {limit} ") : "";
        string where = conditions.Count > 0 ? $"WHERE {string.Join("\n  AND ", conditions)}\n" : "";

        // With totals the grouping goes into a CTE of its own, so the ORDER BY can read the
        // GROUPING flags and the measures by name. SQL Server takes a result column's name in the
        // ORDER BY only on its own, never inside an expression such as the window above.
        var sql = new StringBuilder();
        if (spec.Totals)
        {
            string body = $"SELECT\n    {string.Join(",\n    ", selects)}\nFROM {from}\n{where}{groupBy}";
            ctes.Add("grouped AS (\n" + Indent(body) + "\n)");
            sql.AppendLine("WITH " + string.Join(",\n", ctes));
            sql.AppendLine($"SELECT {top}*");
            sql.AppendLine("FROM grouped");
        }
        else
        {
            if (ctes.Count > 0)
            {
                sql.AppendLine("WITH " + string.Join(",\n", ctes));
            }
            sql.AppendLine($"SELECT {top}".TrimEnd());
            sql.AppendLine("    " + string.Join(",\n    ", selects));
            sql.AppendLine($"FROM {from}");
            sql.Append(where);
            sql.AppendLine(groupBy);
        }
        sql.AppendLine("ORDER BY\n    " + string.Join(",\n    ", order));

        if (provider == DatabaseProvider.Postgres)
        {
            sql.AppendLine(CultureInfo.InvariantCulture, $"LIMIT {limit}");
        }

        var headers = keys.Select(k => k.Name).Concat(measureNames).ToList();
        if (spec.Totals)
        {
            headers.AddRange(keys.Select((_, i) => "__level" + i));
        }
        return new Built(sql.ToString().TrimEnd() + ";", headers, spec.Rows.Count, spec.Columns.Count, spec.Values.Count, limit);
    }

    // A row or column field as the statement knows it: Source is the column it groups by (the
    // table's own, or a period src adds), Name its column in the result.
    private sealed record Key(string Source, string Name);

    private static string Distinct(string name, Func<string, bool> taken)
    {
        string candidate = name;
        for (int n = 2; taken(candidate); n++)
        {
            candidate = $"{name} ({n})";
        }
        return candidate;
    }

    private static string Indent(string text) =>
        string.Join("\n", text.Split('\n').Select(line => "    " + line));

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

    private static PivotMeasure MeasureAt(PivotSpec spec, int index, string field) =>
        index >= 0 && index < spec.Values.Count
            ? spec.Values[index]
            : throw new InvalidOperationException($"'{field}' refers to value {index + 1}, and there are {spec.Values.Count}.");

    // Whether a measure comes back as a number a value filter can compare. MIN and MAX keep their
    // column's type, which can be text or a date.
    private static bool IsNumericMeasure(Dictionary<string, ColumnSummary> columns, PivotMeasure measure) =>
        measure.Aggregate switch
        {
            Aggregate.Count or Aggregate.CountDistinct or Aggregate.Sum or Aggregate.Avg => true,
            _ => measure.Column is not null && IsSummable(Resolve(columns, measure.Column).TypeName),
        };

    private static string Operator(CompareOp op) => op switch
    {
        CompareOp.Greater => ">",
        CompareOp.GreaterOrEqual => ">=",
        CompareOp.Less => "<",
        CompareOp.LessOrEqual => "<=",
        CompareOp.Equal => "=",
        _ => "<>",
    };

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

    // A date column rolled up to a period. Day and longer come back as a date, the period's first
    // day. Hour, minute and second come back as ISO text cut after the unit, 'yyyy-mm-dd hh:mi',
    // which groups and sorts the same as the time itself. The text form is what keeps SQL Server
    // simple: DATETRUNC only exists from 2022, the DATEADD/DATEDIFF trick overflows an int at
    // seconds, and style 120 truncates rather than rounds, so 23:59:59.997 stays in its own day.
    private static string PeriodExpression(DatabaseProvider provider, ColumnSummary column, DateGrain grain)
    {
        string quoted = Quote(provider, column.Name);

        if (!IsDate(column.TypeName))
        {
            throw new InvalidOperationException($"'{column.Name}' is {column.TypeName}; a date period needs a date column.");
        }
        if (grain is DateGrain.Hour or DateGrain.Minute or DateGrain.Second && !HasTime(column.TypeName))
        {
            throw new InvalidOperationException($"'{column.Name}' is {column.TypeName} and has no time of day to group by the {grain.ToString().ToLowerInvariant()}.");
        }

        if (provider == DatabaseProvider.Postgres)
        {
            return grain switch
            {
                DateGrain.Year => $"date_trunc('year', {quoted})::date",
                DateGrain.Quarter => $"date_trunc('quarter', {quoted})::date",
                DateGrain.Month => $"date_trunc('month', {quoted})::date",
                DateGrain.Day => $"{quoted}::date",
                DateGrain.Hour => $"to_char({quoted}, 'YYYY-MM-DD HH24')",
                DateGrain.Minute => $"to_char({quoted}, 'YYYY-MM-DD HH24:MI')",
                _ => $"to_char({quoted}, 'YYYY-MM-DD HH24:MI:SS')",
            };
        }

        return grain switch
        {
            DateGrain.Year => $"DATEFROMPARTS(YEAR({quoted}), 1, 1)",
            DateGrain.Quarter => $"DATEFROMPARTS(YEAR({quoted}), (DATEPART(quarter, {quoted}) - 1) * 3 + 1, 1)",
            DateGrain.Month => $"DATEFROMPARTS(YEAR({quoted}), MONTH({quoted}), 1)",
            DateGrain.Day => $"CAST({quoted} AS date)",
            DateGrain.Hour => $"CONVERT(varchar(13), {quoted}, 120)",
            DateGrain.Minute => $"CONVERT(varchar(16), {quoted}, 120)",
            _ => $"CONVERT(varchar(19), {quoted}, 120)",
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

    private static bool HasTime(string typeName) => IsDate(typeName) && !typeName.Equals("date", StringComparison.OrdinalIgnoreCase);

    private static bool IsIntegral(string typeName) => typeName.ToLowerInvariant() is
        "tinyint" or "smallint" or "int" or "integer" or "bigint";

    // Which aggregates make sense for a column, so the screen never offers SUM over a name.
    public static bool IsSummable(string typeName) => typeName.ToLowerInvariant() is
        "tinyint" or "smallint" or "int" or "integer" or "bigint" or "decimal" or "numeric" or
        "money" or "smallmoney" or "float" or "real" or "double precision" or "float8" or "float4";
}
