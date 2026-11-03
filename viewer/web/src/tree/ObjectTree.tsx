import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { api, type DatabaseInfo, type TreeEntry } from "../api";
import { Icon, type IconName } from "../Icon";
import { setSetting, useSetting } from "../settings";

// The object tree on the left of every page inside a server, after SSMS's Object Explorer.
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

const serverKey = (alias: string) => ["server", alias].join(SEP);
const namesKey = (alias: string, db: string) => ["names", alias, db].join(SEP);

// ---------------------------------------------------------------- node ids

const dbId = (db: string) => ["db", db].join(SEP);
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
    // A row that is not a node: still loading, a failure (clicking it tries again), a hint, the
    // note that a database is empty, the line saying the system databases are hidden, or the
    // heading above them once they are shown.
    note?: "loading" | "error" | "hint" | "empty" | "system" | "section";
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
    return dbId(db);
}

// The nodes that have to be open for the current page's node to be on screen.
function ancestors(place: Place, grouped: boolean): string[] {
    const { db, section, schema } = place;
    if (!db) {
        return [];
    }
    const ids = [dbId(db)];
    if (section && KIND_INFO.has(section)) {
        if (schema) {
            ids.push(folderId(db, section));
            if (grouped && place.name) {
                ids.push(schemaId(db, section, schema));
            }
        }
    }
    return ids;
}

// ---------------------------------------------------------------- rows

interface BuildInput {
    alias: string;
    product: string;
    databases: DatabaseInfo[];
    expanded: Set<string>;
    grouped: boolean;
    filter: string;
    showSystem: boolean;
}

function buildRows({ alias, product, databases, expanded, grouped, filter, showSystem }: BuildInput): Row[] {
    const rows: Row[] = [];
    const base = `/app/${encodeURIComponent(alias)}`;
    const searching = filter.length > 0;
    const system = SYSTEM_DATABASES[product] ?? new Set<string>();
    const isSystem = (database: DatabaseInfo) => system.has(database.name.toLowerCase());
    const userDatabases = databases.filter((x) => !isSystem(x));
    const systemDatabases = databases.filter(isSystem);
    // Hidden system databases are not searched either: what is not shown cannot be a match.
    const listed = showSystem ? databases : userDatabases;

    if (searching) {
        const unread = listed.filter((d) => d.isBrowsable && read(namesKey(alias, d.name))?.status !== "ready").length;
        if (unread > 0) {
            rows.push({
                id: "hint:unread",
                parent: null,
                depth: 0,
                label: `${unread} ${unread === 1 ? "database is" : "databases are"} not read yet. Search them too`,
                note: "hint",
                expandable: false,
                expanded: false,
            });
        }
    }

    const pushDatabase = (rows: Row[], database: DatabaseInfo, d: number, parent: string | null) => {
        const db = database.name;
        const dbHref = `${base}/${encodeURIComponent(db)}`;
        const id = dbId(db);
        const inventory = read<TreeEntry[]>(namesKey(alias, db));

        // While searching only the databases with a match are listed, opened.
        let matches: TreeEntry[] | null = null;
        if (searching) {
            if (inventory?.status !== "ready") {
                return;
            }
            matches = inventory.value.filter((e) => `${e.schema}.${e.name}`.toLowerCase().includes(filter));
            if (matches.length === 0) {
                return;
            }
        }

        const open = searching || (database.isBrowsable && expanded.has(id));
        rows.push({
            id,
            parent,
            depth: d,
            label: db,
            icon: "database",
            muted: !database.isBrowsable,
            expandable: database.isBrowsable && !searching,
            expanded: open,
            href: database.isBrowsable ? dbHref : undefined,
        });
        if (!open) {
            return;
        }

        if (!inventory || inventory.status === "loading") {
            rows.push({ id: `${id}${SEP}loading`, parent: id, depth: d + 1, label: "Reading…", note: "loading", expandable: false, expanded: false });
            return;
        }
        if (inventory.status === "error") {
            rows.push({
                id: `${id}${SEP}error`,
                parent: id,
                depth: d + 1,
                label: `${inventory.error} Click to try again.`,
                note: "error",
                retryKey: namesKey(alias, db),
                expandable: false,
                expanded: false,
            });
            return;
        }

        const entries = matches ?? inventory.value;
        if (entries.length === 0) {
            // model, msdb and many a new database hold nothing of their own. Saying so beats an
            // open node with nothing under it.
            rows.push({ id: `${id}${SEP}empty`, parent: id, depth: d + 1, label: "No objects.", note: "empty", expandable: false, expanded: false });
            return;
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
                parent: id,
                depth: d + 1,
                label,
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
                    pushObject(entry, fid, d + 2, `${entry.schema}.${entry.name}`);
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
                    depth: d + 2,
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
                        pushObject(list[j], sid, d + 3, list[j].name);
                    }
                }
                i = end;
            }
        }
    };

    for (const database of userDatabases) {
        pushDatabase(rows, database, 0, null);
    }

    // The engine's own databases are hidden unless asked for. Shown, they come last under a
    // heading of their own, out of the way of the databases people came for.
    if (systemDatabases.length === 0) {
        return rows;
    }
    if (!showSystem) {
        if (!searching) {
            rows.push({
                id: "hint:system",
                parent: null,
                depth: 0,
                label: `${systemDatabases.length} system ${systemDatabases.length === 1 ? "database" : "databases"} hidden`,
                note: "system",
                expandable: false,
                expanded: false,
            });
        }
        return rows;
    }
    const below: Row[] = [];
    for (const database of systemDatabases) {
        pushDatabase(below, database, 0, null);
    }
    // While searching the heading is there only when something under it matches.
    if (below.length > 0) {
        rows.push({ id: "section:system", parent: null, depth: 0, label: "System", note: "section", expandable: false, expanded: false });
        for (const row of below) {
            rows.push(row.parent === null && row.icon === "database" ? { ...row, muted: true } : row);
        }
    }
    return rows;
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

// Typing into these is not a request for the tree's filter.
function isTyping(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || !!el.closest(".monaco-editor"));
}

// ---------------------------------------------------------------- component

export function ObjectTree({ alias }: { alias: string }) {
    const { pathname } = useLocation();
    const navigate = useNavigate();
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

    const place = useMemo(() => locate(pathname), [pathname]);
    const current = currentId(place, grouped);

    // The page on the right moved: open the way to it. Done while rendering, not in an effect,
    // so the tree never draws one frame with the path still closed.
    const server = read<{ server: { product: string }; databases: DatabaseInfo[] }>(serverKey(alias));
    const databases = server?.status === "ready" ? server.value.databases : NO_DATABASES;
    const product = server?.status === "ready" ? server.value.server.product : "";
    // A link straight into a system database shows them even while the setting hides them: the
    // page on the right always has its node in the tree.
    const showSystemSetting = useSetting("tree.showSystemDatabases");
    const inSystem = place.db !== undefined && (SYSTEM_DATABASES[product]?.has(place.db.toLowerCase()) ?? false);
    const showSystem = showSystemSetting || inSystem;
    // The product is part of the key: which folder a database sits in is known only once the
    // server has answered, and the way to it is opened again then.
    const revealKey = `${grouped}${SEP}${product}${SEP}${current}`;
    const [revealed, setRevealed] = useState<string | null>(null);
    if (revealed !== revealKey) {
        setRevealed(revealKey);
        const missing = ancestors(place, grouped).filter((id) => !expanded.has(id));
        if (missing.length > 0) {
            setExpanded(new Set([...expanded, ...missing]));
        }
    }

    const filter = search.trim().toLowerCase();

    // Read whatever the open nodes need. Nothing here sets state before a request settles.
    useEffect(() => {
        ensure(serverKey(alias), () => api.server(alias), bump);
        for (const id of expanded) {
            const [what, db] = id.split(SEP);
            if (what === "db") {
                ensure(namesKey(alias, db), () => api.names(alias, db), bump);
            }
        }
    }, [alias, expanded]);

    // The cache is read while rendering, and every request that settles bumps `settled`, so the
    // rows are rebuilt exactly when something they show has arrived.
    const rows = useMemo(
        () => buildRows({ alias, product, databases, expanded, grouped, filter, showSystem }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [alias, product, databases, expanded, grouped, filter, showSystem, settled],
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
        setExpanded((previous) => new Set(previous));
    };

    // Searching covers the databases that have been read. This reads the rest.
    const readAll = () => {
        const system = SYSTEM_DATABASES[product] ?? new Set<string>();
        for (const d of databases) {
            if (d.isBrowsable && (showSystem || !system.has(d.name.toLowerCase()))) {
                ensure(namesKey(alias, d.name), () => api.names(alias, d.name), bump);
            }
        }
        bump();
    };

    const refresh = () => {
        for (const key of [...cache.keys()]) {
            if (key.split(SEP)[1] === alias) {
                cache.delete(key);
            }
        }
        setExpanded((previous) => new Set(previous));
        bump();
    };

    const activate = (row: Row) => {
        if (row.note === "error" && row.retryKey) {
            retry(row.retryKey);
        } else if (row.note === "hint") {
            readAll();
        } else if (row.note === "system") {
            setSetting("tree.showSystemDatabases", true);
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

    // Under the breadcrumb bar, down to the bottom of the window. The bar wraps on a narrow
    // window, so its height is measured.
    useLayoutEffect(() => {
        const crumbs = document.querySelector<HTMLElement>(".crumbs");
        const measure = () => aside.current?.style.setProperty("--tree-top", `${crumbs?.offsetHeight ?? 0}px`);
        measure();
        const observer = new ResizeObserver(measure);
        if (crumbs) {
            observer.observe(crumbs);
        }
        return () => observer.disconnect();
    }, [prefs.hidden]);

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

    // "/" anywhere outside a text field goes to the filter, as in GitHub or VS Code's explorer.
    useEffect(() => {
        const onKey = (e: globalThis.KeyboardEvent) => {
            if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target)) {
                e.preventDefault();
                if (prefs.hidden) {
                    // The box is not on the page yet; it is once the tree is drawn again.
                    setPrefs((p) => ({ ...p, hidden: false }));
                    requestAnimationFrame(() => filterBox.current?.focus());
                } else {
                    filterBox.current?.focus();
                }
            }
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [prefs.hidden]);

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
                <button type="button" className="otree-show" title="Show the object tree" onClick={() => updatePrefs({ ...prefs, hidden: false })}>
                    »
                </button>
            </aside>
        );
    }

    // ---- what is drawn

    const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
    const last = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW) + OVERSCAN);
    const footerDb = place.db ? read<TreeEntry[]>(namesKey(alias, place.db)) : undefined;

    return (
        <aside className="otree" ref={aside} style={{ width: prefs.width }}>
            <div className="otree-head">
                <div className="otree-title">
                    <Icon name="server" size={14} />
                    <span className="mono">{alias}</span>
                    {server?.status === "ready" && <span className="muted">{databases.length} databases</span>}
                    <button type="button" className="otree-icon-button" title="Read the tree again" onClick={refresh}>
                        ↻
                    </button>
                </div>
                <div className="otree-filter">
                    <Icon name="search" size={13} />
                    <input
                        ref={filterBox}
                        type="search"
                        placeholder="Filter objects…"
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
                    {!search && <kbd>/</kbd>}
                </div>
                <div className="otree-mode" role="group" aria-label="Grouping">
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
                {(!server || server.status === "loading") && <div className="otree-note">Reading the server…</div>}
                {server?.status === "ready" && rows.length === 0 && (
                    <div className="otree-note">{filter ? "Nothing matches." : "No databases."}</div>
                )}
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
                                {row.note === "system" && <span className="action">show</span>}
                                {row.note === "section" && showSystemSetting && (
                                    <button
                                        type="button"
                                        className="action"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setSetting("tree.showSystemDatabases", false);
                                        }}
                                    >
                                        hide
                                    </button>
                                )}
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
                            onDoubleClick: () => row.expandable && toggle(row.id),
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
                <button type="button" className="link-button" onClick={() => updatePrefs({ ...prefs, hidden: true })}>
                    « hide
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
