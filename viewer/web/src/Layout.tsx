import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { AppRoutes } from "./routes";
import { ShortcutHelp } from "./ShortcutHelp";
import { ObjectTree } from "./tree/ObjectTree";
import { TreeHeader } from "./tree/TreeHeader";
import { TabBar } from "./tabs/TabBar";
import { describeRoute, SECTION_LABELS } from "./tabs/tabRoute";
import { CurrentTabProvider, useTabs, type Tab } from "./tabs/TabStore";

import { APP_NAME, HOME, SETTINGS_ROUTE } from "./appInfo";

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

    // The connection screens: /app/_connections/new and /app/_connections/<alias>/edit. The
    // segment after the prefix is not a database, so the trail is spelled out separately.
    if (alias === "_connections") {
        const editing = db && db !== "new";
        crumbs.push({
            label: editing ? `Edit ${decodeURIComponent(db)}` : "New connection",
            href: pathname,
        });
        return crumbs;
    }

    if (alias === "_settings") {
        crumbs.push({ label: "Settings", href: SETTINGS_ROUTE });
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

    // A query tab is one page, "Query 2", not a list called Query with an entry called 2. A link
    // to the bare /query would open a new query rather than go anywhere up the trail.
    if (section === "query") {
        crumbs.push({ label: schema ? `Query ${decodeURIComponent(schema)}` : "Query", href: pathname });
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

// The active tab's trail, under the tab bar. One for the window rather than one per tab: it is
// part of the sticky head, and pages that sit under that head measure it.
function Breadcrumbs({ pathname }: { pathname: string }) {
    const crumbs = buildCrumbs(pathname);

    // The window title carries the same trail as the breadcrumb, so a window picker or a bookmark
    // says where in the tree you are, not just which application this is.
    // The title has less room than the bar, so the trail keeps the house alone where the
    // breadcrumb spells the application out.
    const trail = crumbs.map((crumb, i) => (i === 0 ? HOME : crumb.label)).join(" / ");
    useEffect(() => {
        document.title = crumbs.length > 1 ? trail : `${HOME} ${APP_NAME}`;
    }, [trail, crumbs.length]);

    // The house is left out: the way home is above the tree. A trail of a single crumb is left out
    // too, since it would only repeat the tab's own title.
    const shown = crumbs.slice(1);
    if (shown.length < 2) {
        return null;
    }

    return (
        <nav className="crumbs" aria-label="Breadcrumb">
            {shown.map((crumb, index) => {
                const last = index === shown.length - 1;
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

// One open tab: its page, drawn for the tab's own location. Hidden tabs stay
// mounted, so a query keeps running and an editor keeps its text while another tab is in front.
//
// Memoised on the tab object, which the store only replaces when that tab changes: switching
// tabs or typing in one must not re-render all the others.
const TabFrame = memo(function TabFrame({ tab, active }: { tab: Tab; active: boolean }) {
    const location = useMemo(
        () => ({ pathname: tab.pathname, search: tab.search, hash: "", state: tab.state ?? null, key: tab.id }),
        [tab.pathname, tab.search, tab.state, tab.id],
    );
    return (
        <section className="tab-frame" hidden={!active} role="tabpanel">
            <CurrentTabProvider id={tab.id} active={active}>
                <AppRoutes location={location} />
            </CurrentTabProvider>
        </section>
    );
});

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

    const tabs = useTabs();
    const { pathname } = useLocation();

    // The tree shows the active tab's server. A tab with no server (the connection list, the
    // settings) leaves the last one in place rather than emptying the column.
    const server = describeRoute(pathname).alias ?? null;
    const [lastServer, setLastServer] = useState<string | null>(server);
    if (server && server !== lastServer) {
        setLastServer(server);
    }
    const treeServer = server ?? lastServer;
    // Keyed by server, so moving to another one starts a fresh tree rather than one with the
    // last server's nodes open. Held as one element so a change of tab does not redraw it.
    const tree = useMemo(
        () =>
            treeServer ? (
                <ObjectTree key={treeServer} alias={treeServer} />
            ) : (
                <aside className="otree otree-empty">
                    <TreeHeader />
                    <div className="otree-hint">Open a server from the connection list.</div>
                </aside>
            ),
        [treeServer],
    );

    // The window scrolls, not the tab, so each tab's scroll position is kept here and given back
    // when the tab comes to the front again.
    const scrolls = useRef(new Map<string, number>());
    const activeRef = useRef(tabs.activeId);
    useLayoutEffect(() => {
        activeRef.current = tabs.activeId;
        window.scrollTo(0, (tabs.activeId && scrolls.current.get(tabs.activeId)) || 0);
    }, [tabs.activeId]);
    useEffect(() => {
        const onScroll = () => {
            if (activeRef.current) {
                scrolls.current.set(activeRef.current, window.scrollY);
            }
        };
        window.addEventListener("scroll", onScroll, { passive: true });
        return () => window.removeEventListener("scroll", onScroll);
    }, []);

    return (
        <div className="shell">
            <div className="with-tree">
                {tree}
                <main className="with-tree-main">
                    {/* Sticks to the top as one block, so a page has one height to stay under. */}
                    <div className="tab-head">
                        <TabBar />
                        <Breadcrumbs pathname={pathname} />
                    </div>
                    {tabs.tabs.map((tab) => (
                        <TabFrame key={tab.id} tab={tab} active={tab.id === tabs.activeId} />
                    ))}
                </main>
            </div>
            <ShortcutHelp />
        </div>
    );
}
