using System.Security.Cryptography;
using System.Text;

namespace SqlMetadataGenerator;

// SQL Server obje isimlerini her platformda geçerli, çakışmasız dosya adlarına çevirir.
// Neden gerekli:
// - Path.GetInvalidFileNameChars platform bağımlıdır (macOS/Linux'ta neredeyse
// hiçbir şeyi engellemez), o yüzden tüm platformların geçersiz karakter kümesini sabit tutarız.
// - Windows'ta CON/PRN/NUL/COM1... gibi rezerve isimler ve sonu nokta/boşlukla biten adlar yasaktır.
// - Sanitize sonrası iki farklı SQL objesi aynı ada düşebilir (ör. "A/B" ve "A_B"); ayrıca
// macOS/Windows dosya sistemleri case-insensitive olduğundan "Order" ve "order" da çakışır.
// Bu durumda orijinal adın kısa hash'i eklenerek benzersizlik garanti edilir.
// Dosya adı yalnızca bir etikettir; gerçek obje adı script içinde korunduğundan bilgi kaybı olmaz.
public sealed class SafeFileName
{
    // Tüm platformlarda yasak sayacağımız karakterler (Windows kümesi en geniştir).
    private static readonly char[] InvalidChars =
        ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

    // Windows rezerve cihaz isimleri (uzantıdan bağımsız, case-insensitive).
    private static readonly HashSet<string> ReservedNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL", "CLOCK$",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    };

    // .sql uzantısı + olası "__<hash>" eki için pay bırakarak güvenli üst sınır.
    private const int MaxBaseLength = 200;

    // Verilmiş dosya adlarını (uzantısız) case-insensitive izleyerek çakışmaları çözer.
    private readonly HashSet<string> _used = new(StringComparer.OrdinalIgnoreCase);

    // Verilen ham obje adından (ör. "dbo.MyTable") bu kapsamda benzersiz, güvenli,
    // uzantısız bir dosya adı üretir ve sonraki çağrılar için rezerve eder.
    public string Reserve(string rawName)
    {
        string safe = MakeSafe(rawName);

        if (_used.Add(safe))
        {
            return safe;
        }

        // Çakışma: orijinal adın kısa hash'iyle ayrıştır (deterministik).
        string hashed = Append(safe, ShortHash(rawName));
        if (_used.Add(hashed))
        {
            return hashed;
        }

        // Aşırı nadir: hash de çakışırsa artan sayaçla benzersizleştir.
        for (int i = 2; ; i++)
        {
            string candidate = Append(safe, ShortHash(rawName) + "_" + i);
            if (_used.Add(candidate))
            {
                return candidate;
            }
        }
    }

    // Adı geçerli bir dosya adına indirger (çakışma yönetimi yok).
    public static string MakeSafe(string rawName)
    {
        var sb = new StringBuilder(rawName.Length);
        foreach (char c in rawName)
        {
            if (c < 0x20 || Array.IndexOf(InvalidChars, c) >= 0)
            {
                sb.Append('_');
            }
            else
            {
                sb.Append(c);
            }
        }

        // Windows: sondaki nokta ve boşluklar yasak.
        string result = sb.ToString().TrimEnd('.', ' ');

        if (result.Length == 0)
        {
            result = "_";
        }

        // Rezerve cihaz ismiyse çakışmayı önlemek için başına alt çizgi ekle.
        if (ReservedNames.Contains(result))
        {
            result = "_" + result;
        }

        if (result.Length > MaxBaseLength)
        {
            result = result[..MaxBaseLength].TrimEnd('.', ' ');
        }

        return result;
    }

    private static string Append(string baseName, string suffix) => $"{baseName}__{suffix}";

    // Çakışmayı çözmeye yetecek kadar kısa, deterministik hash (8 hex).
    private static string ShortHash(string value)
    {
        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return Convert.ToHexString(hash, 0, 4).ToLowerInvariant();
    }
}
