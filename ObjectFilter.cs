namespace SqlMetadataGenerator;

/// <summary>
/// Komut satırı exclusion kuralları: tip, şema ve isim (substring) bazında.
/// Bir nesne herhangi bir kurala uyuyorsa dışlanır (VEYA mantığı).
/// </summary>
public sealed class ObjectFilter
{
    /// <summary>--exclude için geçerli tip adları.</summary>
    public static readonly IReadOnlySet<string> ValidTypes = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "schemas", "tables", "views", "procedures", "functions", "triggers", "synonyms",
    };

    private readonly HashSet<string> _types;
    private readonly HashSet<string> _schemas;
    private readonly List<string> _namePatterns;

    public ObjectFilter(
        IEnumerable<string> excludedTypes,
        IEnumerable<string> excludedSchemas,
        IEnumerable<string> excludedNamePatterns)
    {
        _types = new HashSet<string>(excludedTypes, StringComparer.OrdinalIgnoreCase);
        _schemas = new HashSet<string>(excludedSchemas, StringComparer.OrdinalIgnoreCase);
        _namePatterns = excludedNamePatterns.ToList();
    }

    public static ObjectFilter Empty { get; } = new([], [], []);

    /// <summary>Bu tip dışlanmamış mı? (tip adları: tables, views, procedures, functions, triggers, synonyms, schemas)</summary>
    public bool IncludesType(string type) => !_types.Contains(type);

    /// <summary>Verilen şema/ad çiftindeki nesne şema veya isim kuralıyla dışlanmamış mı?</summary>
    public bool IncludesObject(string schema, string name) =>
        !_schemas.Contains(schema)
        && !_namePatterns.Any(p => name.Contains(p, StringComparison.OrdinalIgnoreCase));

    /// <summary>Modül tiplerinden (view/procedure/function/trigger) en az biri dahil mi?</summary>
    public bool HasAnyModuleType =>
        IncludesType("views") || IncludesType("procedures")
        || IncludesType("functions") || IncludesType("triggers");
}
