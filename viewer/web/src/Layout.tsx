import { Link, Outlet, useLocation } from "react-router-dom";

import { api } from "./api";
import { useApi } from "./useApi";

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
    // "sunucu", "veritabanı", "şema" gibi tür etiketi; bölüm sayfalarında yok.
    kind?: string;
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
    const crumbs: Crumb[] = [{ label: "Bağlantılar", href: "/app" }];
    if (!alias) {
        return crumbs;
    }

    const a = encodeURIComponent(alias);
    crumbs.push({
        kind: "sunucu",
        label: decodeURIComponent(alias),
        detail: serverAddress ?? undefined,
        href: `/app/${a}`,
        mono: true,
    });
    if (!db) {
        return crumbs;
    }

    const d = encodeURIComponent(db);
    crumbs.push({ kind: "veritabanı", label: decodeURIComponent(db), href: `/app/${a}/${d}`, mono: true });
    if (!section) {
        return crumbs;
    }

    crumbs.push({ label: SECTION_LABELS[section] ?? section, href: `/app/${a}/${d}/${section}` });
    if (!schema) {
        return crumbs;
    }

    const s = encodeURIComponent(schema);
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
                        {crumb.kind && <span className="kind">{crumb.kind}</span>}
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
