# SqlMetadataGenerator

SQL Server veritabanının creation script'lerini üreten ve bu script'lerden veritabanı
oluşturan .NET 10 konsol uygulaması.

## Kod kuralları (zorunlu)

1. **XML doc yorumu (`<summary>` vb.) KULLANMA.** Otomatik dokümantasyon üretilmiyor; yalnızca
   kaynak kod okunuyor. Açıklama gerekiyorsa düz `//` yorumu yeterli. `///` ve XML etiketleri yasak.

2. **Her zaman kıvırcık parantez (`{ }`) kullan.** `if`/`else`/`for`/`foreach`/`while` blokları
   tek satırlık olsa bile gövde küme parantezi içine alınmalı. Brace'siz tek-satır gövde yasak.
