using Microsoft.Data.SqlClient;

namespace SqlMetadataGenerator;

// Bu araç veritabanını yalnızca OKUR. Her sorgu READ UNCOMMITTED ile çalışır:
// canlı bir sunucuda gezinmek paylaşımlı kilit almamalı ve yazan işleri
// bekletmemeli. Katalog sorguları da dahil — tek bir sorgunun bile bunu
// atlaması, aracın "sunucuya yük bindirmez" iddiasını bozar.
//
// Yalıtım seviyesi bağlantı açıldıktan sonra ayrı bir komutla da verilebilirdi,
// ama bu her bağlantı için fazladan bir gidiş-dönüş demek olurdu (bağlantılar
// havuzdan geldiğinde ayar sıfırlanır). Metnin başına eklemek bedavadır.
public static class ReadOnlyCommand
{
    public const string IsolationPrefix = "SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;\n";

    public static SqlCommand Create(SqlConnection connection, string sql) =>
        new(IsolationPrefix + sql, connection);
}
