namespace SqlMetadataGenerator;

// Command-line exclusion rules by type, schema and name (substring).
// An object is excluded when it matches any rule (OR logic).
public sealed class ObjectFilter
{
    // The valid type names for --exclude.
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

    // Is this type not excluded? (type names: tables, views, procedures, functions, triggers, synonyms, schemas)
    public bool IncludesType(string type) => !_types.Contains(type);

    // Is the object with the given schema/name pair not excluded by a schema or name rule?
    public bool IncludesObject(string schema, string name) =>
        !_schemas.Contains(schema)
        && !_namePatterns.Any(p => name.Contains(p, StringComparison.OrdinalIgnoreCase));

    // Is at least one module type (view/procedure/function/trigger) included?
    public bool HasAnyModuleType =>
        IncludesType("views") || IncludesType("procedures")
        || IncludesType("functions") || IncludesType("triggers");
}
