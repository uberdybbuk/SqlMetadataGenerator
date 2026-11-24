import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { describeRoute } from "./tabRoute";

// The open tabs, and the rule that ties them to the URL.
//
// The URL is always the ACTIVE tab's location. Every navigation, whatever caused it (a click in
// the tree, a link on a page, the back button, a pasted address), lands here as a location
// change, and the one rule below decides which tab it belongs to:
//
//   - a tab with the same key exists: that tab becomes active and moves to the new location
//     (a chip on the table page, the pivot, a schema filter on the list)
//   - otherwise the preview tab, if there is one, is replaced by it
//   - otherwise a new preview tab opens beside the active one
//
// That is VS Code's preview tab: browsing the tree reuses one tab, and a tab becomes permanent
// when it is double-clicked or when something is changed in it.

export interface Tab {
    id: string;
    key: string;
    pathname: string;
    search: string;
    // The navigation state of the location (the pivot hands its SQL over this way). Not stored:
    // what matters of it is copied into the draft when the tab opens.
    state?: unknown;
    preview: boolean;
    // A name the person gave the tab. Shown instead of the title the URL gives it.
    name?: string;
}

interface Store {
    tabs: Tab[];
    activeId: string | null;
    // The SQL typed into a tab's editor, by tab id. Kept apart from the tab so that typing does
    // not rewrite the tab list.
    drafts: Record<string, string>;
    // A bare /query URL has just become /query/<n>; the address bar still has to follow.
    redirect?: { pathname: string; search: string };
}

interface StoredTabs {
    tabs: { id: string; pathname: string; search: string; preview: boolean; name?: string }[];
    activeId: string | null;
    drafts: Record<string, string>;
}

const STORE_KEY = "sqlbrowser.tabs";

function newId(): string {
    return Math.random().toString(36).slice(2, 10);
}

function load(): Store {
    try {
        const stored = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null") as StoredTabs | null;
        if (stored && Array.isArray(stored.tabs)) {
            const tabs = stored.tabs.map((t) => ({ ...t, key: describeRoute(t.pathname).key }));
            // A draft belongs to a tab. One whose tab is gone would sit in storage for ever.
            const drafts: Record<string, string> = {};
            for (const tab of tabs) {
                if (typeof stored.drafts?.[tab.id] === "string") {
                    drafts[tab.id] = stored.drafts[tab.id];
                }
            }
            return { tabs, activeId: stored.activeId, drafts };
        }
    } catch {
        // Unreadable or blocked storage: start with no tabs, the URL opens the first one.
    }
    return { tabs: [], activeId: null, drafts: {} };
}

function save(store: Store): void {
    const stored: StoredTabs = {
        tabs: store.tabs.map(({ id, pathname, search, preview, name }) => ({ id, pathname, search, preview, name })),
        activeId: store.activeId,
        drafts: store.drafts,
    };
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(stored));
    } catch {
        // Full or blocked storage only costs the restore after a reload.
    }
}

// The next free query number. Counted from the open tabs, so closing every query starts at 1 again.
function nextQueryNumber(tabs: Tab[]): number {
    let max = 0;
    for (const tab of tabs) {
        const match = /\/query\/(\d+)$/.exec(tab.key);
        if (match) {
            max = Math.max(max, Number(match[1]));
        }
    }
    return max + 1;
}

function insertAfterActive(store: Store, tab: Tab): Tab[] {
    const index = store.tabs.findIndex((t) => t.id === store.activeId);
    const tabs = [...store.tabs];
    tabs.splice(index < 0 ? tabs.length : index + 1, 0, tab);
    return tabs;
}

interface Place {
    pathname: string;
    search: string;
    state: unknown;
}

function sync(store: Store, place: Place): Store {
    const route = describeRoute(place.pathname);

    if (route.newQuery) {
        const pathname = `${place.pathname.replace(/\/$/, "")}/${nextQueryNumber(store.tabs)}`;
        const tab: Tab = {
            id: newId(),
            key: describeRoute(pathname).key,
            pathname,
            search: place.search,
            preview: false,
        };
        const handed = (place.state as { sql?: string } | null)?.sql;
        return {
            tabs: insertAfterActive(store, tab),
            activeId: tab.id,
            drafts: typeof handed === "string" ? { ...store.drafts, [tab.id]: handed } : store.drafts,
            redirect: { pathname, search: place.search },
        };
    }

    const existing = store.tabs.find((t) => t.key === route.key);
    if (existing) {
        const moved = existing.pathname !== place.pathname || existing.search !== place.search || existing.state !== place.state;
        return {
            ...store,
            redirect: undefined,
            activeId: existing.id,
            tabs: moved
                ? store.tabs.map((t) =>
                      t.id === existing.id ? { ...t, pathname: place.pathname, search: place.search, state: place.state } : t,
                  )
                : store.tabs,
        };
    }

    // A new id even when the preview tab is reused: it is a different page, and the page that was
    // there must not hand its state to this one.
    const tab: Tab = { id: newId(), key: route.key, pathname: place.pathname, search: place.search, state: place.state, preview: true };
    const preview = store.tabs.find((t) => t.preview);
    if (preview) {
        const drafts = { ...store.drafts };
        delete drafts[preview.id];
        return {
            tabs: store.tabs.map((t) => (t.id === preview.id ? tab : t)),
            activeId: tab.id,
            drafts,
        };
    }
    return { tabs: insertAfterActive(store, tab), activeId: tab.id, drafts: store.drafts };
}

export interface TabsApi {
    tabs: Tab[];
    activeId: string | null;
    active: Tab | undefined;
    busy: ReadonlySet<string>;
    isDirty: (id: string) => boolean;
    activate: (id: string) => void;
    // Closes without asking. Whoever lets a person close a tab asks first when isDirty says so.
    close: (id: string, then?: string) => void;
    pin: (id: string) => void;
    // Moves a tab so that it ends up in front of the tab at `before` in the current order, or
    // last when `before` is the length of the list.
    move: (id: string, before: number) => void;
    // Gives a tab its own name and keeps it. An empty name gives back the title from the URL.
    rename: (id: string, name: string) => void;
    draft: (id: string) => string | undefined;
    setDraft: (id: string, text: string) => void;
    setBusy: (id: string, busy: boolean) => void;
}

const TabsContext = createContext<TabsApi | null>(null);

export function TabsProvider({ children }: { children: ReactNode }) {
    const location = useLocation();
    const navigate = useNavigate();
    const [store, setStore] = useState(load);
    const [busy, setBusyState] = useState<ReadonlySet<string>>(() => new Set());

    // Synced while rendering, not in an effect: the tab for a new location has to exist in the
    // very render that shows it, or every navigation would draw one frame of the old tab.
    const [syncedFor, setSyncedFor] = useState<string | null>(null);
    if (syncedFor !== location.key) {
        setSyncedFor(location.key);
        setStore((s) => sync(s, { pathname: location.pathname, search: location.search, state: location.state }));
    }

    useEffect(() => {
        if (store.redirect) {
            navigate(store.redirect.pathname + store.redirect.search, { replace: true });
        }
    }, [store.redirect, navigate]);

    // Written a moment after the last change: the drafts change on every keystroke.
    useEffect(() => {
        const handle = window.setTimeout(() => save(store), 300);
        return () => window.clearTimeout(handle);
    }, [store]);

    const storeRef = useRef(store);
    storeRef.current = store;

    const go = useCallback(
        (tab: Tab) => navigate(tab.pathname + tab.search, { state: tab.state }),
        [navigate],
    );

    const activate = useCallback(
        (id: string) => {
            const tab = storeRef.current.tabs.find((t) => t.id === id);
            if (tab && id !== storeRef.current.activeId) {
                go(tab);
            }
        },
        [go],
    );

    const close = useCallback(
        (id: string, then?: string) => {
            const current = storeRef.current;
            const index = current.tabs.findIndex((t) => t.id === id);
            if (index < 0) {
                return;
            }
            const tabs = current.tabs.filter((t) => t.id !== id);
            const drafts = { ...current.drafts };
            delete drafts[id];
            // The neighbour to the right takes the place of a closed active tab, as in a browser.
            const neighbour = tabs[index] ?? tabs[index - 1];
            const wasActive = id === current.activeId;
            setStore({
                tabs,
                drafts,
                activeId: wasActive ? (neighbour?.id ?? null) : current.activeId,
            });
            if (then) {
                navigate(then);
            } else if (wasActive) {
                if (neighbour) {
                    go(neighbour);
                } else {
                    navigate("/app");
                }
            }
        },
        [go, navigate],
    );

    const pin = useCallback((id: string) => {
        setStore((s) => (s.tabs.some((t) => t.id === id && t.preview) ? { ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, preview: false } : t)) } : s));
    }, []);

    const move = useCallback((id: string, before: number) => {
        setStore((s) => {
            const from = s.tabs.findIndex((t) => t.id === id);
            // Dropped on its own place, on either side: nothing moves.
            if (from < 0 || before === from || before === from + 1) {
                return s;
            }
            const tabs = [...s.tabs];
            const [tab] = tabs.splice(from, 1);
            tabs.splice(before > from ? before - 1 : before, 0, tab);
            return { ...s, tabs };
        });
    }, []);

    const rename = useCallback((id: string, name: string) => {
        const trimmed = name.trim() || undefined;
        setStore((s) =>
            s.tabs.some((t) => t.id === id && (t.name !== trimmed || t.preview))
                ? { ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, name: trimmed, preview: false } : t)) }
                : s,
        );
    }, []);

    const draft = useCallback((id: string) => storeRef.current.drafts[id], []);

    const setDraft = useCallback((id: string, text: string) => {
        setStore((s) => (s.drafts[id] === text ? s : { ...s, drafts: { ...s.drafts, [id]: text } }));
    }, []);

    const setBusy = useCallback((id: string, value: boolean) => {
        setBusyState((current) => {
            if (current.has(id) === value) {
                return current;
            }
            const next = new Set(current);
            if (value) {
                next.add(id);
            } else {
                next.delete(id);
            }
            return next;
        });
    }, []);

    // Which tabs HAVE a draft, as a value that only changes when that set changes. Typing changes
    // the draft on every keystroke, and if that reached the context, every open tab and the tree
    // would re-render with each letter.
    const dirtyKey = Object.keys(store.drafts).sort().join("\n");
    const dirty = useMemo(() => new Set(dirtyKey.split("\n").filter(Boolean)), [dirtyKey]);
    const isDirty = useCallback((id: string) => dirty.has(id), [dirty]);

    // Closing or reloading the page asks nothing: every tab and its SQL comes back on the next
    // visit. That only holds if the last keystrokes are written, and the 300 ms save above may not
    // have run yet, so the tabs are saved as the page goes.
    useEffect(() => {
        const onLeave = () => save(storeRef.current);
        window.addEventListener("pagehide", onLeave);
        return () => window.removeEventListener("pagehide", onLeave);
    }, []);

    const value = useMemo<TabsApi>(
        () => ({
            tabs: store.tabs,
            activeId: store.activeId,
            active: store.tabs.find((t) => t.id === store.activeId),
            busy,
            isDirty,
            activate,
            close,
            pin,
            move,
            rename,
            draft,
            setDraft,
            setBusy,
        }),
        [store.tabs, store.activeId, busy, isDirty, activate, close, pin, move, rename, draft, setDraft, setBusy],
    );

    return <TabsContext.Provider value={value}>{children}</TabsContext.Provider>;
}

export function useTabs(): TabsApi {
    const tabs = useContext(TabsContext);
    if (!tabs) {
        throw new Error("useTabs outside TabsProvider");
    }
    return tabs;
}

// ---------------------------------------------------------------- inside one tab

export interface CurrentTab {
    id: string;
    // Hidden tabs stay mounted. Anything listening on the whole window (shortcuts, the page
    // title, measurements) has to check this, or every open tab would answer at once.
    active: boolean;
    pin: () => void;
    close: (then?: string) => void;
    draft: string | undefined;
    setDraft: (text: string) => void;
    setBusy: (busy: boolean) => void;
}

const CurrentTabContext = createContext<CurrentTab | null>(null);

export function CurrentTabProvider({ id, active, children }: { id: string; active: boolean; children: ReactNode }) {
    const tabs = useTabs();
    const { pin, close, setDraft, setBusy, draft } = tabs;
    // Read once per render. Only the tab's own editor writes it, and it reads it only to start.
    const initialDraft = draft(id);
    const value = useMemo<CurrentTab>(
        () => ({
            id,
            active,
            pin: () => pin(id),
            close: (then) => close(id, then),
            draft: initialDraft,
            setDraft: (text) => setDraft(id, text),
            setBusy: (value) => setBusy(id, value),
        }),
        // The draft is deliberately left out: a new context on every keystroke would re-render
        // the whole page under the editor.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [id, active, pin, close, setDraft, setBusy],
    );
    return <CurrentTabContext.Provider value={value}>{children}</CurrentTabContext.Provider>;
}

// Null outside a tab, so a component can be used on its own as well.
export function useCurrentTab(): CurrentTab | null {
    return useContext(CurrentTabContext);
}

// True when not inside a tab at all: a component on its own is always the visible one.
export function useTabActive(): boolean {
    return useCurrentTab()?.active ?? true;
}
