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

public sealed class PivotSpec
{
    public List<PivotField> Rows { get; init; } = [];
    public List<PivotMeasure> Values { get; init; } = [];
    public string? Where { get; init; }
    // Subtotals per row level and a grand total, through GROUP BY ROLLUP.
    public bool Totals { get; init; } = true;
    public int Limit { get; init; } = 1000;
}
