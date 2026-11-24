import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { api, type DatabaseInfo, type TreeEntry } from "../api";
import { formatMb } from "../format";
import { useApi } from "../useApi";
import { Icon, type IconName } from "../Icon";
import { setSetting, useSetting } from "../settings";
import { isModKey, MOD } from "../shortcuts";
import { Combo, type ComboItem, type ComboSection } from "./Combo";
import { TreeHeader } from "./TreeHeader";
import { describeRoute } from "../tabs/tabRoute";
import { useTabs } from "../tabs/TabStore";

// The object tree on the left of every page inside a server, after SSMS's Object Explorer. It
// lists one database's objects: two pickers at the top say which server and which database. With
// thirty databases on a server, a list of them would otherwise push the objects, which are what
// you came for, one level in and off the screen.
//
// Where SSMS is slow, this is built to be fast:
//   - a database costs ONE request, names only, for every kind at once. Expanding a folder, a
//     schema or switching the grouping never goes back to the server;
//   - what has been read is kept for the session, so coming back to a database is instant;
//   - only the rows on screen are drawn, so a folder of five thousand procedures opens as fast as
//     one of five.
// It stops at the objects: a table's columns are on its own page, one click away.

const ROW = 22;
// Rows drawn above and below the visible ones, so a fast scroll does not show blank space.
const OVERSCAN = 12;
const SEP = "\u001f";

const KINDS: { kind: string; label: string; icon: IconName }[] = [
    { kind: "tables", label: "Tables", icon: "table" },
    { kind: "views", label: "Views", icon: "view" },
    { kind: "procedures", label: "Procedures", icon: "procedure" },
    { kind: "functions", label: "Functions", icon: "function" },
    { kind: "triggers", label: "Triggers", icon: "trigger" },
    { kind: "synonyms", label: "Synonyms", icon: "synonym" },
    { kind: "sequences", label: "Sequences", icon: "sequence" },
    { kind: "types", label: "Types", icon: "type" },
];
const KIND_INFO = new Map(KINDS.map((k) => [k.kind, k]));

const NO_DATABASES: DatabaseInfo[] = [];
const NO_SYSTEM_DATABASES = new Set<string>();

// How many databases the server page's tree offers as "largest" while none is selected.
const LARGEST_DATABASES = 5;

// The databases each engine brings along, by the product name the server reports.
const SYSTEM_DATABASES: Record<string, Set<string>> = {
    "SQL Server": new Set(["master", "model", "msdb", "tempdb"]),
    PostgreSQL: new Set(["postgres", "template0", "template1"]),
};

// ---------------------------------------------------------------- session cache

type Loadable<T> =
    | { status: "loading" }
    | { status: "ready"; value: T; ms: number }
    | { status: "error"; error: string };

// Kept for the whole session and shared by every tree instance, so leaving a server and coming
// back, or remounting the layout, never reads a database again.
const cache = new Map<string, Loadable<unknown>>();

function read<T>(key: string): Loadable<T> | undefined {
    return cache.get(key) as Loadable<T> | undefined;
}

// Starts the request unless it is in flight or done. done() is called once it has settled.
function ensure<T>(key: string, fetcher: () => Promise<T>, done: () => void): void {
    if (cache.has(key)) {
        return;
    }
    const started = performance.now();
    cache.set(key, { status: "loading" });
    fetcher().then(
        (value) => cache.set(key, { status: "ready", value, ms: Math.round(performance.now() - started) }),
        (err: unknown) => cache.set(key, { status: "error", error: err instanceof Error ? err.message : String(err) }),
    ).finally(done);
}

// Mounted trees, told when the cache under them was emptied from outside.
const listeners = new Set<() => void>();

// Drops everything read through a connection. Called when the connection itself is saved or
// deleted: the entry may now point at another host, and an answer (or a failure) read through the
// old one must not outlive it. The tree stays mounted behind the connection form, so it is told.
export function forgetServer(alias: string): void {
    for (const key of [...cache.keys()]) {
        if (key.split(SEP)[1] === alias) {
            cache.delete(key);
        }
    }
    for (const listener of listeners) {
        listener();
    }
}

const serverKey = (alias: string) => ["server", alias].join(SEP);
const namesKey = (alias: string, db: string) => ["names", alias, db].join(SEP);

// ---------------------------------------------------------------- node ids

const folderId = (db: string, kind: string) => ["folder", db, kind].join(SEP);
const schemaId = (db: string, kind: string, schema: string) => ["schema", db, kind, schema].join(SEP);
const objectId = (db: string, kind: string, schema: string, name: string) => ["object", db, kind, schema, name].join(SEP);

interface Row {
    id: string;
    parent: string | null;
    depth: number;
    label: string;
    icon?: IconName;
    count?: number;
    muted?: boolean;
    expandable: boolean;
    expanded: boolean;
    href?: string;
    // A row that is not a node: still loading, a failure (clicking it tries again), or the note
    // that a database has nothing to list.
    note?: "loading" | "error" | "empty";
    retryKey?: string;
}

// Where the page on the right is, in the tree's terms.
interface Place {
    db?: string;
    section?: string;
    schema?: string;
    name?: string;
}

function locate(pathname: string): Place {
    const [app, , db, section, schema, name] = pathname.split("/").filter(Boolean).map(decodeURIComponent);
    return app === "app" ? { db, section, schema, name } : {};
}

function currentId(place: Place, grouped: boolean): string | null {
    const { db, section, schema, name } = place;
    if (!db) {
        return null;
    }
    if (section && KIND_INFO.has(section)) {
        if (schema && name) {
            return objectId(db, section, schema, name);
        }
        if (schema && grouped) {
            return schemaId(db, section, schema);
        }
        return folderId(db, section);
    }
    return null;
}

// The nodes that have to be open for the current page's node to be on screen.
function ancestors(place: Place, grouped: boolean): string[] {
    const { db, section, schema } = place;
    if (!db || !section || !KIND_INFO.has(section)) {
        return [];
    }
    // The folder itself too, on its own list page: the tree holds nothing else to look at, and
    // moving to another database lands right there.
    const ids = [folderId(db, section)];
    if (schema && grouped && place.name) {
        ids.push(schemaId(db, section, schema));
    }
    return ids;
}

// ---------------------------------------------------------------- rows

interface BuildInput {
    alias: string;
    db: string;
    // What the server says about this database. Unknown until it has answered, or for a name it
    // does not list.
    database: DatabaseInfo | undefined;
    expanded: Set<string>;
    grouped: boolean;
    filter: string;
}

function buildRows({ alias, db, database, expanded, grouped, filter }: BuildInput): Row[] {
    const rows: Row[] = [];
    const dbHref = `/app/${encodeURIComponent(alias)}/${encodeURIComponent(db)}`;
    const searching = filter.length > 0;
    const note = (kind: NonNullable<Row["note"]>, label: string, retryKey?: string): Row => ({
        id: `note${SEP}${kind}`,
        parent: null,
        depth: 0,
        label,
        note: kind,
        retryKey,
        expandable: false,
        expanded: false,
    });

    if (database && !database.isBrowsable) {
        return [note("empty", `This database cannot be read (${database.state}).`)];
    }

    const inventory = read<TreeEntry[]>(namesKey(alias, db));
    if (!inventory || inventory.status === "loading") {
        return [note("loading", "Reading…")];
    }
    if (inventory.status === "error") {
        return [note("error", `${inventory.error} Click to try again.`, namesKey(alias, db))];
    }

    const entries = searching
        ? inventory.value.filter((e) => `${e.schema}.${e.name}`.toLowerCase().includes(filter))
        : inventory.value;
    if (entries.length === 0) {
        // model, msdb and many a new database hold nothing of their own. Saying so beats an
        // empty panel. A filter with no match says so under the filter's own heading instead.
        return searching ? [] : [note("empty", "No objects.")];
    }

    const byKind = new Map<string, TreeEntry[]>();
    for (const entry of entries) {
        const list = byKind.get(entry.kind);
        if (list) {
            list.push(entry);
        } else {
            byKind.set(entry.kind, [entry]);
        }
    }

    for (const { kind, label, icon } of KINDS) {
        const list = byKind.get(kind);
        if (!list) {
            continue;
        }
        const fid = folderId(db, kind);
        const folderOpen = searching || expanded.has(fid);
        rows.push({
            id: fid,
            parent: null,
            depth: 0,
            label,
            icon,
            count: list.length,
            expandable: !searching,
            expanded: folderOpen,
            href: `${dbHref}/${kind}`,
        });
        if (!folderOpen) {
            continue;
        }

        const pushObject = (entry: TreeEntry, parent: string, depth: number, text: string) => {
            rows.push({
                id: objectId(db, kind, entry.schema, entry.name),
                parent,
                depth,
                label: text,
                icon,
                expandable: false,
                expanded: false,
                href: `${dbHref}/${kind}/${encodeURIComponent(entry.schema)}/${encodeURIComponent(entry.name)}`,
            });
        };

        if (!grouped) {
            for (const entry of list) {
                pushObject(entry, fid, 1, `${entry.schema}.${entry.name}`);
            }
            continue;
        }

        // The inventory arrives sorted by kind, schema and name, so a schema's objects are
        // already next to each other.
        for (let i = 0; i < list.length; ) {
            const schema = list[i].schema;
            let end = i;
            while (end < list.length && list[end].schema === schema) {
                end++;
            }
            const sid = schemaId(db, kind, schema);
            const schemaOpen = searching || expanded.has(sid);
            rows.push({
                id: sid,
                parent: fid,
                depth: 1,
                label: schema,
                icon: "schema",
                count: end - i,
                expandable: !searching,
                expanded: schemaOpen,
                // Only tables have a page per schema.
                href: kind === "tables" ? `${dbHref}/tables/${encodeURIComponent(schema)}` : undefined,
            });
            if (schemaOpen) {
                for (let j = i; j < end; j++) {
                    pushObject(list[j], sid, 2, list[j].name);
                }
            }
            i = end;
        }
    }
    return rows;
}

// ---------------------------------------------------------------- recent databases

// The last databases opened on each server, newest first: the pickers offer them before the
// long list. This browser's convenience, like the width below.
const RECENT_KEY = "sqlbrowser.recentDatabases";
const RECENT_LIMIT = 3;

function loadRecent(): Record<string, string[]> {
    try {
        const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "{}");
        return parsed && typeof parsed === "object" ? (parsed as Record<string, string[]>) : {};
    } catch {
        return {};
    }
}

function recentDatabases(alias: string): string[] {
    const list = loadRecent()[alias];
    return Array.isArray(list) ? list : [];
}

function rememberDatabase(alias: string, db: string): void {
    const next = [db, ...recentDatabases(alias).filter((name) => name !== db)].slice(0, RECENT_LIMIT);
    try {
        localStorage.setItem(RECENT_KEY, JSON.stringify({ ...loadRecent(), [alias]: next }));
    } catch {
        // Storage is off: the pickers simply offer no recent databases.
    }
}

// ---------------------------------------------------------------- width and visibility

// How wide the tree is and whether it is shown: this browser's convenience, nothing more.
const PREFS_KEY = "sqlbrowser.tree";
const MIN_WIDTH = 180;
const MAX_WIDTH = 640;

interface Prefs {
    width: number;
    hidden: boolean;
}

function loadPrefs(): Prefs {
    try {
        const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
        const width = typeof parsed.width === "number" ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, parsed.width)) : 290;
        return { width, hidden: parsed.hidden === true };
    } catch {
        return { width: 290, hidden: false };
    }
}

function savePrefs(prefs: Prefs): void {
    try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
        // Storage is off: the width holds until the page is reloaded.
    }
}

// ---------------------------------------------------------------- component

export function ObjectTree({ alias }: { alias: string }) {
    const { pathname } = useLocation();
    const navigate = useNavigate();
    const tabs = useTabs();
    const grouped = useSetting("tree.groupBySchema");
    const [settled, bump] = useReducer((n: number) => n + 1, 0);
    const [prefs, setPrefs] = useState(loadPrefs);
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
    const [focused, setFocused] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [scrollTop, setScrollTop] = useState(0);
    const [viewport, setViewport] = useState(600);

    const aside = useRef<HTMLElement>(null);
    const list = useRef<HTMLDivElement>(null);
    const filterBox = useRef<HTMLInputElement>(null);
    const drag = useRef<{ x: number; width: number } | null>(null);
    const scrolledTo = useRef<string | null>(null);

    // The tree stays on screen while a tab with no server is in front (the connection list, the
    // settings), and it keeps showing where its own server's last tab was rather than closing up.
    const ownPath = pathname.split("/").filter(Boolean).map(decodeURIComponent)[1] === alias;
    const [lastOwnPath, setLastOwnPath] = useState(() => (ownPath ? pathname : `/app/${encodeURIComponent(alias)}`));
    if (ownPath && pathname !== lastOwnPath) {
        setLastOwnPath(pathname);
    }
    const treePath = ownPath ? pathname : lastOwnPath;
    const place = useMemo(() => locate(treePath), [treePath]);
    const current = currentId(place, grouped);
    const [connectionsWanted, setConnectionsWanted] = useState(false);
    // Asked for when the picker first opens. Adding a connection happens on a page without this
    // tree, so coming back from it mounts a new one that asks again.
    const connections = useApi(() => api.connections(), [], connectionsWanted);

    // The page on the right moved: open the way to it. Done while rendering, not in an effect,
    // so the tree never draws one frame with the path still closed.
    const server = read<{ server: { product: string }; databases: DatabaseInfo[] }>(serverKey(alias));
    const databases = server?.status === "ready" ? server.value.databases : NO_DATABASES;
    const product = server?.status === "ready" ? server.value.server.product : "";
    const system = SYSTEM_DATABASES[product] ?? NO_SYSTEM_DATABASES;
    const isSystem = (database: DatabaseInfo) => system.has(database.name.toLowerCase());
    const selected = databases.find((d) => d.name === place.db);
    // A link straight into a system database shows them even while the setting hides them: the
    // picker always has the database you are in.
    const showSystemSetting = useSetting("tree.showSystemDatabases");
    const inSystem = place.db !== undefined && system.has(place.db.toLowerCase());
    const showSystem = showSystemSetting || inSystem;
    const revealKey = `${grouped}${SEP}${current}`;
    const [revealed, setRevealed] = useState<string | null>(null);
    if (revealed !== revealKey) {
        setRevealed(revealKey);
        const missing = ancestors(place, grouped).filter((id) => !expanded.has(id));
        if (missing.length > 0) {
            setExpanded(new Set([...expanded, ...missing]));
        }
    }

    const filter = search.trim().toLowerCase();

    // Read what is on screen. Nothing here sets state before a request settles. Keyed on `settled`
    // too: a retry or a refresh empties the cache and bumps it, and this reads the entry again.
    const unreadable = selected !== undefined && !selected.isBrowsable;
    useEffect(() => {
        ensure(serverKey(alias), () => api.server(alias), bump);
        if (place.db && !unreadable) {
            const db = place.db;
            ensure(namesKey(alias, db), () => api.names(alias, db), bump);
        }
    }, [alias, place.db, unreadable, settled]);

    useEffect(() => {
        listeners.add(bump);
        return () => {
            listeners.delete(bump);
        };
    }, []);

    useEffect(() => {
        if (place.db) {
            rememberDatabase(alias, place.db);
        }
    }, [alias, place.db]);

    // The cache is read while rendering, and every request that settles bumps `settled`, so the
    // rows are rebuilt exactly when something they show has arrived.
    const rows = useMemo(
        () => (place.db ? buildRows({ alias, db: place.db, database: selected, expanded, grouped, filter }) : []),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [alias, place.db, selected, expanded, grouped, filter, settled],
    );

    const focusIndex = Math.max(0, rows.findIndex((r) => r.id === (focused ?? current)));

    const toggle = useCallback((id: string) => {
        setExpanded((previous) => {
            const next = new Set(previous);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    }, []);

    const expand = (id: string) => {
        if (!expanded.has(id)) {
            toggle(id);
        }
    };

    const retry = (key: string) => {
        cache.delete(key);
        bump();
    };

    const refresh = () => forgetServer(alias);

    const keepTab = (href: string) => {
        const key = describeRoute(href).key;
        const tab = tabs.tabs.find((t) => t.key === key);
        if (tab) {
            tabs.pin(tab.id);
        }
    };

    const activate = (row: Row) => {
        if (row.note === "error" && row.retryKey) {
            retry(row.retryKey);
        } else if (row.href) {
            navigate(row.href);
        } else if (row.expandable) {
            toggle(row.id);
        }
    };

    // ---- scrolling and the visible window

    useLayoutEffect(() => {
        const el = list.current;
        if (!el) {
            return;
        }
        const observer = new ResizeObserver(() => setViewport(el.clientHeight));
        observer.observe(el);
        return () => observer.disconnect();
    }, [prefs.hidden]);

    // Another database is another list: it starts at its top, not at the last one's scroll.
    useLayoutEffect(() => {
        if (list.current) {
            list.current.scrollTop = 0;
        }
    }, [place.db]);

    const scrollToIndex = (index: number) => {
        const el = list.current;
        if (!el || index < 0) {
            return;
        }
        if (index * ROW < el.scrollTop) {
            el.scrollTop = index * ROW;
        } else if ((index + 1) * ROW > el.scrollTop + el.clientHeight) {
            el.scrollTop = (index + 1) * ROW - el.clientHeight;
        }
    };

    // After a navigation, bring the current node into view once — not on every rebuild, or the
    // tree would jump back while someone scrolls it.
    useEffect(() => {
        // Keyed on the grouping too: switching it moves the same node to another line.
        if (!current || scrolledTo.current === revealKey) {
            return;
        }
        const index = rows.findIndex((r) => r.id === current);
        if (index >= 0) {
            scrolledTo.current = revealKey;
            const el = list.current;
            if (el && (index * ROW < el.scrollTop || (index + 1) * ROW > el.scrollTop + el.clientHeight)) {
                el.scrollTop = Math.max(0, index * ROW - el.clientHeight / 3);
            }
        }
    }, [current, revealKey, rows]);

    // Cmd/Ctrl+P goes to the filter from anywhere, the SQL editor included, as VS Code's quick
    // open. Not "/": on a Turkish keyboard that is Shift+7. Taken in the capture phase so the
    // browser's print dialog never opens. What is already in the box is selected, so typing
    // replaces it.
    useEffect(() => {
        const onKey = (e: globalThis.KeyboardEvent) => {
            if (isModKey(e, "p")) {
                e.preventDefault();
                const focus = () => filterBox.current?.select();
                if (prefs.hidden) {
                    // The box is not on the page yet; it is once the tree is drawn again.
                    setPrefs((p) => ({ ...p, hidden: false }));
                    requestAnimationFrame(focus);
                } else {
                    focus();
                }
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [prefs.hidden]);

    // Cmd/Ctrl+U opens the database picker from anywhere, as SSMS's Available Databases box.
    // Taken in the capture phase, so Monaco's own Cmd+U (undo the last cursor move) and the
    // browser's view-source do not get it. Except right after Cmd/Ctrl+K: Cmd+K Cmd+U is the
    // editor's Uncomment and has to reach the editor.
    const [pickDatabase, setPickDatabase] = useState(false);
    useEffect(() => {
        let afterK = false;
        const onKey = (e: globalThis.KeyboardEvent) => {
            if (["Meta", "Control", "Shift", "Alt"].includes(e.key)) {
                return;
            }
            const chord = afterK;
            afterK = isModKey(e, "k");
            if (isModKey(e, "u") && !chord) {
                e.preventDefault();
                e.stopPropagation();
                if (prefs.hidden) {
                    setPrefs((p) => ({ ...p, hidden: false }));
                }
                setPickDatabase(true);
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [prefs.hidden]);

    // Cmd/Ctrl+B shows and hides the tree, as the side bar in VS Code. Taken in the capture phase
    // so it works from inside the SQL editor too.
    useEffect(() => {
        const onKey = (e: globalThis.KeyboardEvent) => {
            if (isModKey(e, "b")) {
                e.preventDefault();
                const next = { ...prefs, hidden: !prefs.hidden };
                setPrefs(next);
                savePrefs(next);
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [prefs]);

    const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
        const row = rows[focusIndex];
        if (!row) {
            return;
        }
        const go = (index: number) => {
            const target = rows[Math.min(rows.length - 1, Math.max(0, index))];
            if (target) {
                setFocused(target.id);
                scrollToIndex(rows.indexOf(target));
            }
        };
        const page = Math.max(1, Math.floor(viewport / ROW) - 1);
        switch (e.key) {
            case "ArrowDown":
                go(focusIndex + 1);
                break;
            case "ArrowUp":
                go(focusIndex - 1);
                break;
            case "PageDown":
                go(focusIndex + page);
                break;
            case "PageUp":
                go(focusIndex - page);
                break;
            case "Home":
                go(0);
                break;
            case "End":
                go(rows.length - 1);
                break;
            case "ArrowRight":
                if (row.expandable && !row.expanded) {
                    toggle(row.id);
                } else if (row.expanded) {
                    go(focusIndex + 1);
                }
                break;
            case "ArrowLeft":
                if (row.expandable && row.expanded) {
                    toggle(row.id);
                } else if (row.parent) {
                    go(rows.findIndex((r) => r.id === row.parent));
                }
                break;
            case "Enter":
                activate(row);
                break;
            case " ":
                if (row.expandable) {
                    toggle(row.id);
                }
                break;
            default:
                return;
        }
        e.preventDefault();
    };

    // ---- width and visibility

    const updatePrefs = (next: Prefs) => {
        setPrefs(next);
        savePrefs(next);
    };

    const onGripDown = (e: PointerEvent<HTMLDivElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, width: prefs.width };
        document.body.classList.add("resizing");
    };
    const onGripMove = (e: PointerEvent<HTMLDivElement>) => {
        if (drag.current) {
            const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, drag.current.width + e.clientX - drag.current.x));
            setPrefs((p) => ({ ...p, width }));
        }
    };
    const onGripUp = () => {
        if (drag.current) {
            drag.current = null;
            document.body.classList.remove("resizing");
            savePrefs(prefs);
        }
    };

    if (prefs.hidden) {
        return (
            <aside className="otree hidden" ref={aside}>
                <button type="button" className="otree-show" title={`Show the object tree (${MOD}B)`} onClick={() => updatePrefs({ ...prefs, hidden: false })}>
                    <Icon name="panel-left-open" />
                </button>
                <TreeHeader compact />
            </aside>
        );
    }

    // ---- the pickers

    const base = `/app/${encodeURIComponent(alias)}`;

    // Moving to another database keeps the kind of page you are on: from a table to that
    // database's table list, since the same table there would exist only by chance.
    const databaseHref = (name: string) =>
        `${base}/${encodeURIComponent(name)}${place.section ? `/${encodeURIComponent(place.section)}` : ""}`;

    const databaseItem = (database: DatabaseInfo, prefix: string): ComboItem => {
        const here = database.name === place.db;
        return {
            key: `${prefix}${SEP}${database.name}`,
            label: database.name,
            icon: "database",
            meta: formatMb(database.dataMb),
            current: here,
            disabled: !database.isBrowsable,
            href: here ? undefined : databaseHref(database.name),
        };
    };

    const userDatabases = databases.filter((d) => !isSystem(d));
    const systemDatabases = databases.filter(isSystem);

    const databaseSections = (query: string): ComboSection[] => {
        const systemSection: ComboSection[] =
            systemDatabases.length === 0
                ? []
                : showSystem
                  ? [{
                        key: "system",
                        title: "System",
                        items: systemDatabases.map((d) => databaseItem(d, "system")),
                        link: showSystemSetting ? { label: "hide", run: () => setSetting("tree.showSystemDatabases", false) } : undefined,
                    }]
                  : [{
                        key: "system",
                        title: `System · ${systemDatabases.length} ${systemDatabases.length === 1 ? "database" : "databases"}`,
                        items: [],
                        link: { label: "show", run: () => setSetting("tree.showSystemDatabases", true) },
                    }];

        // Hidden system databases are not searched either: what is not shown cannot be a match.
        const listed = showSystem ? databases : userDatabases;
        if (query) {
            const items = listed.filter((d) => d.name.toLowerCase().includes(query)).map((d) => databaseItem(d, "match"));
            return [{ key: "matches", items }, ...(showSystem ? [] : systemSection)];
        }

        const recent = recentDatabases(alias).flatMap((name) => listed.filter((d) => d.name === name));
        return [
            ...(recent.length > 0 ? [{ key: "recent", title: "Recent", items: recent.map((d) => databaseItem(d, "recent")) }] : []),
            { key: "all", title: recent.length > 0 ? "All databases" : undefined, items: userDatabases.map((d) => databaseItem(d, "all")) },
            ...systemSection,
        ];
    };

    const serverSections = (): ComboSection[] => {
        let items: ComboItem[];
        if (connections.data) {
            items = connections.data.map((c) => ({
                key: c.alias,
                label: c.alias,
                icon: "server",
                badge: c.provider === "postgres" ? "PostgreSQL" : "SQL Server",
                current: c.alias === alias,
                href: c.alias === alias ? undefined : `/app/${encodeURIComponent(c.alias)}`,
            }));
        } else {
            items = [{ key: "state", label: connections.error ?? "Reading…", disabled: true }];
        }
        return [
            { key: "servers", items },
            {
                key: "manage",
                items: [
                    { key: "new", label: "+ New connection…", action: true, href: "/app/_connections/new" },
                    { key: "manage", label: "Manage connections", action: true, href: "/app" },
                ],
            },
        ];
    };

    // ---- what is drawn

    const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
    const last = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW) + OVERSCAN);
    const footerDb = place.db ? read<TreeEntry[]>(namesKey(alias, place.db)) : undefined;

    return (
        <aside className="otree" ref={aside} style={{ width: prefs.width }}>
            <TreeHeader />
            <div className="otree-head">
                <Combo
                    label="Server"
                    icon="server"
                    value={alias}
                    placeholder=""
                    plain
                    meta={server?.status === "ready" ? `${product} · ${databases.length} db` : undefined}
                    sections={serverSections}
                    emptyText="No connections."
                    onOpen={() => setConnectionsWanted(true)}
                />
                <Combo
                    label="Database"
                    icon="database"
                    value={place.db ?? null}
                    placeholder="Select a database…"
                    meta={selected ? formatMb(selected.dataMb) : undefined}
                    searchPlaceholder={`Filter ${databases.length} databases…`}
                    sections={databaseSections}
                    emptyText={
                        server?.status === "error"
                            ? server.error
                            : server?.status === "ready"
                              ? "No database matches."
                              : "Reading the server…"
                    }
                    keysHint
                    openNow={pickDatabase}
                    onOpened={() => setPickDatabase(false)}
                />
                <div className={place.db ? "otree-filter" : "otree-filter off"}>
                    <Icon name="search" size={13} />
                    <input
                        ref={filterBox}
                        type="search"
                        placeholder={place.db ? `Filter ${place.db}…` : "Filter objects…"}
                        disabled={!place.db}
                        value={search}
                        onChange={(e) => {
                            setSearch(e.target.value);
                            setFocused(null);
                            if (list.current) {
                                list.current.scrollTop = 0;
                            }
                        }}
                        onKeyDown={(e) => {
                            if (e.key === "Escape") {
                                setSearch("");
                            } else if (e.key === "ArrowDown" || e.key === "Enter") {
                                e.preventDefault();
                                const firstObject = rows.find((r) => r.id.startsWith("object")) ?? rows[0];
                                if (firstObject) {
                                    setFocused(firstObject.id);
                                    if (e.key === "Enter") {
                                        activate(firstObject);
                                    }
                                }
                                list.current?.focus();
                            }
                        }}
                    />
                    {!search && <kbd>{MOD}P</kbd>}
                </div>
                <div className={place.db ? "otree-mode" : "otree-mode off"} role="group" aria-label="Grouping">
                    <button type="button" className={grouped ? "" : "on"} onClick={() => setSetting("tree.groupBySchema", false)}>
                        flat
                    </button>
                    <button type="button" className={grouped ? "on" : ""} onClick={() => setSetting("tree.groupBySchema", true)}>
                        by schema
                    </button>
                </div>
            </div>

            <div
                className="otree-list"
                ref={list}
                tabIndex={0}
                role="tree"
                aria-label="Objects"
                onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
                onKeyDown={onListKey}
            >
                {server?.status === "error" && <div className="otree-note error">{server.error}</div>}
                {!place.db && server?.status === "ready" && (
                    <NoDatabase
                        base={base}
                        recent={recentDatabases(alias).flatMap((name) => databases.filter((d) => d.name === name && d.isBrowsable))}
                        largest={[...userDatabases].filter((d) => d.isBrowsable).sort((a, b) => b.dataMb - a.dataMb).slice(0, LARGEST_DATABASES)}
                    />
                )}
                {place.db && filter && rows.length === 0 && <div className="otree-note">Nothing matches.</div>}
                <div style={{ height: rows.length * ROW, position: "relative" }}>
                    {rows.slice(first, last).map((row, i) => {
                        const index = first + i;
                        const classes = ["otree-row"];
                        if (row.id === current) {
                            classes.push("current");
                        }
                        if (row.id === focused) {
                            classes.push("focused");
                        }
                        if (row.muted) {
                            classes.push("muted");
                        }
                        if (row.note) {
                            classes.push(`note ${row.note}`);
                        }
                        const linked = row.href !== undefined && !row.note;
                        const body = (
                            <>
                                <span
                                    className={row.expandable ? "chev" : "chev none"}
                                    onClick={(e) => {
                                        // The arrow only opens and closes; it does not follow the row's link.
                                        e.preventDefault();
                                        e.stopPropagation();
                                        if (row.expandable) {
                                            toggle(row.id);
                                        }
                                    }}
                                >
                                    {row.expandable ? (row.expanded ? "▾" : "▸") : ""}
                                </span>
                                {row.icon && <Icon name={row.icon} size={14} />}
                                <span className="label">{row.label}</span>
                                {row.count !== undefined && <span className="count">{row.count.toLocaleString("en-US")}</span>}
                            </>
                        );
                        const shared = {
                            className: classes.join(" "),
                            role: "treeitem",
                            "aria-level": row.depth + 1,
                            "aria-expanded": row.expandable ? row.expanded : undefined,
                            "aria-selected": row.id === current,
                            title: row.label,
                            style: { top: index * ROW, paddingLeft: 4 + row.depth * 14 },
                            onMouseDown: () => setFocused(row.id),
                            // A double click keeps the object's tab: the single click before it
                            // opened it in the preview tab, which the next click would replace.
                            onDoubleClick: () => {
                                if (row.expandable) {
                                    toggle(row.id);
                                }
                                if (row.href) {
                                    keepTab(row.href);
                                }
                            },
                        };
                        // The whole row is the link, not just its text: the target is the line,
                        // as in a file explorer. A real anchor, so Cmd-click opens a new tab.
                        return linked ? (
                            <Link
                                key={row.id}
                                {...shared}
                                to={row.href!}
                                tabIndex={-1}
                                onClick={() => {
                                    if (row.expandable) {
                                        expand(row.id);
                                    }
                                }}
                            >
                                {body}
                            </Link>
                        ) : (
                            <div key={row.id} {...shared} onClick={() => activate(row)}>
                                {body}
                            </div>
                        );
                    })}
                </div>
            </div>

            <div className="otree-foot">
                <span className="muted">
                    {footerDb?.status === "ready"
                        ? `${place.db}: ${footerDb.value.length.toLocaleString("en-US")} objects · ${footerDb.ms} ms`
                        : ""}
                </span>
                <button type="button" className="icon-button" title="Read the server and this database again" onClick={refresh}>
                    <Icon name="refresh" />
                </button>
                <button
                    type="button"
                    className="icon-button"
                    title={`Hide the object tree (${MOD}B)`}
                    onClick={() => updatePrefs({ ...prefs, hidden: true })}
                >
                    <Icon name="panel-left-close" />
                </button>
            </div>
            <div
                className="otree-grip"
                onPointerDown={onGripDown}
                onPointerMove={onGripMove}
                onPointerUp={onGripUp}
                onPointerCancel={onGripUp}
                title="Drag to resize"
            />
        </aside>
    );
}

// On the server's own page no database is selected yet. Rather than an empty panel, the likely
// next steps: where you were last, and where the space is.
function NoDatabase({ base, recent, largest }: { base: string; recent: DatabaseInfo[]; largest: DatabaseInfo[] }) {
    const group = (title: string, list: DatabaseInfo[]) =>
        list.length > 0 && (
            <div className="otree-pick">
                <div className="otree-pick-title">{title}</div>
                {list.map((d) => (
                    <Link key={d.name} className="otree-pick-item" to={`${base}/${encodeURIComponent(d.name)}`} title={d.name}>
                        <Icon name="database" size={14} />
                        <span className="label">{d.name}</span>
                        <span className="count">{formatMb(d.dataMb)}</span>
                    </Link>
                ))}
            </div>
        );
    return (
        <>
            <div className="otree-empty">
                <b>No database selected</b>
                Pick one above to see its objects.
            </div>
            {group("Recent", recent)}
            {group("Largest", largest)}
        </>
    );
}
