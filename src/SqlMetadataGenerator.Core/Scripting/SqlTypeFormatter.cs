namespace SqlMetadataGenerator.Scripting;

// Sistem veri tipini uzunluk/precision/scale ile biçimlendirir
// (varchar(50), nvarchar(max), decimal(18, 2), datetime2(7) ...).
public static class SqlTypeFormatter
{
    public static string Format(string typeName, short maxLength, byte precision, byte scale, ScriptFormat fmt)
    {
        string t = typeName.ToLowerInvariant();
        string name = fmt.Kw(t);

        switch (t)
        {
            case "varchar" or "char" or "varbinary" or "binary":
                return $"{name}({LengthToken(maxLength, divideByTwo: false, fmt)})";

            case "nvarchar" or "nchar":
                return $"{name}({LengthToken(maxLength, divideByTwo: true, fmt)})";

            case "decimal" or "numeric":
                return $"{name}({precision}, {scale})";

            // Bu tipler için scale fractional second precision'ı belirtir.
            case "datetime2" or "datetimeoffset" or "time":
                return $"{name}({scale})";

            default:
                return name;
        }
    }

    private static string LengthToken(short maxLength, bool divideByTwo, ScriptFormat fmt)
    {
        if (maxLength == -1)
        {
            return fmt.Kw("max");
        }

        int length = divideByTwo ? maxLength / 2 : maxLength;
        return length.ToString();
    }
}
