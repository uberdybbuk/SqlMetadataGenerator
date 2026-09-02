import { Link, Outlet, useLocation } from "react-router-dom";

import { api } from "./api";
import { useApi } from "./useApi";
import { Icon, type IconName } from "./Icon";

// URL'deki tip segmentinin (tables, views ...) okunur karşılıkları.
// Anahtarlar ObjectFilter.ValidTypes sözlüğüyle aynı: CLI, manifest ve URL tek dil konuşur.
const SECTION_LABELS: Record<string, string> = {
    tables: "Tablolar",
    views: "View'lar",
    procedures: "Procedure'lar",
    functions: "Function'lar",
    triggers: "Trigger'lar",
    synonyms: "Synonym'lar",
    sequences: "Sequence'lar",
    types: "Tipler",
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
    tables: "tablo",
    views: "view",
    procedures: "procedure",
    functions: "function",
    triggers: "trigger",
    synonyms: "synonym",
    sequences: "sequence",
    types: "tip",
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
    const crumbs: Crumb[] = [{ label: "Bağlantılar", href: "/app" }];
    if (!alias) {
        return crumbs;
    }

    const a = encodeURIComponent(alias);
    crumbs.push({
        kind: "sunucu",
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
        kind: "veritabanı",
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
        kind: "şema",
        label: decodeURIComponent(schema),
        href: `/app/${a}/${d}/${section}/${s}`,
        mono: true,
    });
    if (!name) {
        return crumbs;
    }

    crumbs.push({
        kind: OBJECT_LABELS[section] ?? "nesne",
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
        <nav className="crumbs" aria-label="Konum">
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
    return (
        <div className="shell">
            <Breadcrumbs />
            <Outlet />
        </div>
    );
}
