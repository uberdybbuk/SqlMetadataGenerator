import { useEffect } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";

export const HOME = "🏠";
export const APP_NAME = "SQL Browser";

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
    schemas: "Schemas",
};

interface Crumb {
    label: string;
    href: string;
    mono?: boolean;
    // Screen readers get a word where the eye gets a pictogram.
    aria?: string;
}

// The breadcrumb path is built from the ROUTE STRUCTURE, not segment by segment:
//   /app/<alias>/<db>/<type>/<schema>/<name>
// That way what each part is ("server", "database", "schema") is spelled out; bare URL
// fragments carried no meaning on their own.
function buildCrumbs(pathname: string): Crumb[] {
    const parts = pathname.split("/").filter(Boolean);
    if (parts[0] !== "app") {
        return [];
    }

    const [, alias, db, section, schema, name] = parts;
    const crumbs: Crumb[] = [{ label: `${HOME} ${APP_NAME}`, href: "/app" }];
    if (!alias) {
        return crumbs;
    }

    const a = encodeURIComponent(alias);
    crumbs.push({
        label: decodeURIComponent(alias),
        href: `/app/${a}`,
        mono: true,
    });
    if (!db) {
        return crumbs;
    }

    const d = encodeURIComponent(db);
    crumbs.push({
        label: decodeURIComponent(db),
        href: `/app/${a}/${d}`,
        mono: true,
    });
    if (!section) {
        return crumbs;
    }

    crumbs.push({
        label: SECTION_LABELS[section] ?? section,
        href: `/app/${a}/${d}/${section}`,
    });
    if (!schema) {
        return crumbs;
    }

    const s = encodeURIComponent(schema);
    crumbs.push({
        label: decodeURIComponent(schema),
        href: `/app/${a}/${d}/${section}/${s}`,
        mono: true,
    });
    if (!name) {
        return crumbs;
    }

    crumbs.push({
        label: decodeURIComponent(name),
        href: `/app/${a}/${d}/${section}/${s}/${encodeURIComponent(name)}`,
        mono: true,
    });
    return crumbs;
}

function Breadcrumbs() {
    const { pathname } = useLocation();
    const crumbs = buildCrumbs(pathname);

    // The tab title carries the same trail as the breadcrumb, so a window picker or a bookmark
    // says where in the tree you are, not just which application this is.
    // The tab has less room than the bar, so the trail keeps the house alone where the
    // breadcrumb spells the application out.
    const trail = crumbs.map((crumb, i) => (i === 0 ? HOME : crumb.label)).join(" / ");
    useEffect(() => {
        document.title = crumbs.length > 1 ? trail : `${HOME} ${APP_NAME}`;
    }, [trail, crumbs.length]);

    // On the home page the trail would be a single house sitting above a heading that already
    // says the same thing. A breadcrumb with one crumb tells you nothing anyway.
    if (crumbs.length < 2) {
        return null;
    }

    return (
        <nav className="crumbs" aria-label="Breadcrumb">
            {crumbs.map((crumb, index) => {
                const last = index === crumbs.length - 1;
                return (
                    <span key={crumb.href} className="crumb">
                        {last ? (
                            <span className={crumb.mono ? "current mono" : "current"} aria-label={crumb.aria}>
                                {crumb.label}
                            </span>
                        ) : (
                            <Link
                                className={crumb.mono ? "mono" : undefined}
                                to={crumb.href}
                                aria-label={crumb.aria}
                            >
                                {crumb.label}
                            </Link>
                        )}
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
