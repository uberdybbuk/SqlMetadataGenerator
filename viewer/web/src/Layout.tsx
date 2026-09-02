import { useEffect } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";

import { api } from "./api";
import { useApi } from "./useApi";
import { Icon, type IconName } from "./Icon";

// URL'deki tip segmentinin (tables, views ...) okunur karşılıkları.
// Anahtarlar ObjectFilter.ValidTypes sözlüğüyle aynı: CLI, manifest ve URL tek dil konuşur.
const SECTION_LABELS: Record<string, string> = {
    tables: "Tables",
    views: "Views",
    procedures: "Procedures",
    functions: "Functions",
    triggers: "Triggers",
    synonyms: "Synonyms",
    sequences: "Sequences",
    types: "Types",
};

const SECTION_ICONS: Record<string, IconName> = {
    tables: "table",
    views: "view",
    procedures: "procedure",
    functions: "function",
    triggers: "trigger",
    synonyms: "synonym",
    sequences: "sequence",
    types: "type",
};

const OBJECT_LABELS: Record<string, string> = {
    tables: "table",
    views: "view",
    procedures: "procedure",
    functions: "function",
    triggers: "trigger",
    synonyms: "synonym",
    sequences: "sequence",
    types: "type",
};

interface Crumb {
    // Ekranda gösterilmez; yalnızca ikonun erişilebilir adı olarak kullanılır.
    kind?: string;
    icon?: IconName;
    label: string;
    // Sunucu için gerçek adres — alias tek başına neyi işaret ettiğini söylemiyor.
    detail?: string;
    href: string;
    mono?: boolean;
}

// Breadcrumb yolu segment segment değil, ROTA YAPISINA göre kurulur:
//   /app/<alias>/<db>/<tip>/<şema>/<ad>
// Böylece her parçanın ne olduğu ("sunucu", "veritabanı", "şema") yazıyla görünür;
// çıplak URL parçaları tek başına anlam taşımıyordu.
function buildCrumbs(pathname: string, serverAddress: string | null): Crumb[] {
    const parts = pathname.split("/").filter(Boolean);
    if (parts[0] !== "app") {
        return [];
    }

    const [, alias, db, section, schema, name] = parts;
    // İlk parça bir varlık değil, sayfa adı — ikonu yok. Aksi hâlde yanındaki
    // sunucu ikonuyla aynı görünüp iki ayrı şeyi aynı sanmaya yol açıyordu.
    const crumbs: Crumb[] = [{ label: "Connections", href: "/app" }];
    if (!alias) {
        return crumbs;
    }

    const a = encodeURIComponent(alias);
    crumbs.push({
        kind: "server",
        icon: "server",
        label: decodeURIComponent(alias),
        detail: serverAddress ?? undefined,
        href: `/app/${a}`,
        mono: true,
    });
    if (!db) {
        return crumbs;
    }

    const d = encodeURIComponent(db);
    crumbs.push({
        kind: "database",
        icon: "database",
        label: decodeURIComponent(db),
        href: `/app/${a}/${d}`,
        mono: true,
    });
    if (!section) {
        return crumbs;
    }

    // Bölüm crumb'ında ikon yok: "Tablolar" sözcüğü zaten türü söylüyor, ikon
    // onu tekrar ederdi. İkon yalnızca adın kendisinin ne olduğunu söylemediği
    // yerlerde var — sunucu, veritabanı ve nesnenin kendisi.
    crumbs.push({
        label: SECTION_LABELS[section] ?? section,
        href: `/app/${a}/${d}/${section}`,
    });
    if (!schema) {
        return crumbs;
    }

    const s = encodeURIComponent(schema);
    // Şemanın ikonu yok: bulunduğu yer zaten ne olduğunu söylüyor.
    crumbs.push({
        kind: "schema",
        label: decodeURIComponent(schema),
        href: `/app/${a}/${d}/${section}/${s}`,
        mono: true,
    });
    if (!name) {
        return crumbs;
    }

    crumbs.push({
        kind: OBJECT_LABELS[section] ?? "object",
        icon: SECTION_ICONS[section],
        label: decodeURIComponent(name),
        href: `/app/${a}/${d}/${section}/${s}/${encodeURIComponent(name)}`,
        mono: true,
    });
    return crumbs;
}

function Breadcrumbs() {
    const { pathname } = useLocation();
    // Layout gezinme boyunca ayakta kaldığı için bu istek oturumda bir kez atılır.
    const connections = useApi(() => api.connections(), []);

    const alias = pathname.split("/").filter(Boolean)[1];
    const address =
        connections.data?.find((c) => c.alias.toLowerCase() === alias?.toLowerCase())?.server ?? null;

    const crumbs = buildCrumbs(pathname, address);

    return (
        <nav className="crumbs" aria-label="Breadcrumb">
            {crumbs.map((crumb, index) => {
                const last = index === crumbs.length - 1;
                return (
                    <span key={crumb.href} className="crumb">
                        {crumb.icon && <Icon name={crumb.icon} label={crumb.kind ?? crumb.label} />}
                        {last ? (
                            <span className={crumb.mono ? "current mono" : "current"}>{crumb.label}</span>
                        ) : (
                            <Link className={crumb.mono ? "mono" : undefined} to={crumb.href}>
                                {crumb.label}
                            </Link>
                        )}
                        {crumb.detail && <span className="detail">{crumb.detail}</span>}
                        {!last && <span className="sep">/</span>}
                    </span>
                );
            })}
        </nav>
    );
}

export function Layout() {
    // Monaco ~2.6 MB'lık ayrı bir parça. İlk tabloya tıklandığında indirilmesini
    // beklemek yerine uygulama açılır açılmaz arka planda çekilir; modülün üst
    // seviye kodu da (dil kaydı, worker ayarı) o sırada çalışır. Kullanıcı veri
    // sekmesine geldiğinde editör hazır olur.
    useEffect(() => {
        // timeout şart: boşta kalma anı gelmezse (uzun tablo listesi render'ı gibi)
        // ısınma hiç çalışmıyor ve ilk editör yine yarım saniye geciktiriyordu.
        const warm = () => {
            void import("./SqlEditor").then((module) => module.warmUp());
        };
        const handle = window.requestIdleCallback
            ? window.requestIdleCallback(warm, { timeout: 1200 })
            : window.setTimeout(warm, 300);
        return () => {
            window.cancelIdleCallback?.(handle as number);
        };
    }, []);

    return (
        <div className="shell">
            <Breadcrumbs />
            <Outlet />
        </div>
    );
}
