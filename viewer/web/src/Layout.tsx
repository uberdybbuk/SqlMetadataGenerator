import { useEffect } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";

import { api } from "./api";
import { useApi } from "./useApi";
import { Icon, type IconName } from "./Icon";

// Readable equivalents of the type segment in the URL (tables, views ...).
// The keys match the ObjectFilter.ValidTypes vocabulary: the CLI, the manifest and the URL speak one language.
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
    // Never shown on screen; used only as the icon's accessible name.
    kind?: string;
    icon?: IconName;
    label: string;
    // The real address of the server — an alias alone does not say what it points at.
    detail?: string;
    href: string;
    mono?: boolean;
}

// The breadcrumb path is built from the ROUTE STRUCTURE, not segment by segment:
//   /app/<alias>/<db>/<type>/<schema>/<name>
// That way what each part is ("server", "database", "schema") is spelled out; bare URL
// fragments carried no meaning on their own.
function buildCrumbs(pathname: string, serverAddress: string | null): Crumb[] {
    const parts = pathname.split("/").filter(Boolean);
    if (parts[0] !== "app") {
        return [];
    }

    const [, alias, db, section, schema, name] = parts;
    // The first part is a page name, not an entity — so it has no icon. Otherwise it looked
    // just like the server icon next to it, which invited reading two different things as one.
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

    // The section crumb has no icon: the word "Tables" already says what the kind is, and an
    // icon would only repeat it. Icons appear only where the name itself does not say what the
    // thing is — the server, the database and the object itself.
    crumbs.push({
        label: SECTION_LABELS[section] ?? section,
        href: `/app/${a}/${d}/${section}`,
    });
    if (!schema) {
        return crumbs;
    }

    const s = encodeURIComponent(schema);
    // The schema has no icon: where it sits already says what it is.
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
    // Because the Layout stays mounted across navigation, this request is made once per session.
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
    // Monaco is a separate ~2.6 MB chunk. Rather than waiting for it to download on the first
    // table click, it is fetched in the background as soon as the app opens; the module's
    // top-level code (language registration, worker setup) runs then too. By the time the user
    // reaches the data tab the editor is ready.
    useEffect(() => {
        // The timeout is required: when an idle moment never comes (a long table list rendering,
        // say) the warm-up never ran and the first editor still cost half a second.
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
