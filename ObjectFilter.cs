namespace SqlMetadataGenerator;

// Komut satırı exclusion kuralları: tip, şema ve isim (substring) bazında.
// Bir nesne herhangi bir kurala uyuyorsa dışlanır (VEYA mantığı).
public sealed class ObjectFilter
{
    // --exclude için geçerli tip adları.
    public static readonly IReadOnlySet<string> ValidTypes = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "schemas", "sequences", "types", "tables", "views", "procedures", "functions", "triggers", "synonyms",
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

    // Bu tip dışlanmamış mı? (tip adları: tables, views, procedures, functions, triggers, synonyms, schemas)
    public bool IncludesType(string type) => !_types.Contains(type);

    // Verilen şema/ad çiftindeki nesne şema veya isim kuralıyla dışlanmamış mı?
    public bool IncludesObject(string schema, string name) =>
        !_schemas.Contains(schema)
        && !_namePatterns.Any(p => name.Contains(p, StringComparison.OrdinalIgnoreCase));

    // Modül tiplerinden (view/procedure/function/trigger) en az biri dahil mi?
    public bool HasAnyModuleType =>
        IncludesType("views") || IncludesType("procedures")
        || IncludesType("functions") || IncludesType("triggers");
}
