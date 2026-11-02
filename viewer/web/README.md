# viewer/web

SqlMetadataGenerator'ın tarayıcı arayüzü. Vite + React + TypeScript.

## Geliştirme

Önce API'yi başlat (repo kökünden):

```
export SQLMETA_PW_DEMO=...
dotnet run --project src/SqlMetadataGenerator.Web
```

Sonra bu klasörde:

```
npm install
npm run dev
```

`http://localhost:7750` açılır; `/api` istekleri `:7751`'a proxy'lenir, böylece
frontend her iki modda da `/api/...` yazar ve CORS gerekmez.

## Production

```
npm run build
```

Çıktı doğrudan `src/SqlMetadataGenerator.Web/wwwroot/` altına yazılır ve ASP.NET
Core tarafından sunulur. Tek process, tek port.

## Rotalar

URL konumdur; her seviye gerçek bir sayfadır ve bookmark'lanabilir.

```
/app                                    bağlantılar
/app/<alias>                            sunucu dashboard'u
/app/<alias>/<db>                       db dashboard'u (treemap)
/app/<alias>/<db>/tables                tüm tablolar
/app/<alias>/<db>/tables/<schema>       şemadaki tablolar
/app/<alias>/<db>/tables/<schema>/<ad>  tablo detayı
```
