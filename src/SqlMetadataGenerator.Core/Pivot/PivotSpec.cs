namespace SqlMetadataGenerator.Pivot;

// What to group by, and how. Granularity applies to date and time columns only: grouping a
// datetime2 as it stands yields one group per microsecond, which is not an analysis, so a date
// field is always rolled up to a period.
public enum DateGrain
{
    None,
    Year,
    Quarter,
    Month,
    Day,
}

public enum Aggregate
{
    Count,
    CountDistinct,
    Sum,
    Avg,
    Min,
    Max,
}

public sealed record PivotField(string Column, DateGrain Grain = DateGrain.None);

// Column is null for Count, which counts rows rather than values.
public sealed record PivotMeasure(Aggregate Aggregate, string? Column = null);

// Excel's report filter: a field and the values ticked in its list. A null entry stands for NULL.
//
// Exclude exists because the list the screen offers is the most frequent values, not all of them.
// Unticking one value of an all-ticked list has to mean "everything but this", and as an include
// list it would silently drop every value the list never showed.
public sealed record PivotFilter(string Column, List<string?> Values, bool Exclude = false);

public sealed class PivotSpec
{
    public List<PivotField> Rows { get; init; } = [];
    // The cross-tab fields. Their values become the screen's column headers; the statement only
    // groups by them, and the screen folds the result into a matrix.
    public List<PivotField> Columns { get; init; } = [];
    public List<PivotMeasure> Values { get; init; } = [];
    public List<PivotFilter> Filters { get; init; } = [];
    public string? Where { get; init; }
    // Subtotals per row level and a grand total, through GROUP BY ROLLUP.
    public bool Totals { get; init; } = true;
    public int Limit { get; init; } = 1000;
}
