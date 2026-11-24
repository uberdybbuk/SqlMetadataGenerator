import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useNavigate } from "react-router-dom";

import { Icon } from "../Icon";
import { IS_MAC, isAltKey } from "../shortcuts";
import { describeRoute } from "./tabRoute";
import { useTabs, type Tab } from "./TabStore";

// The strip of open tabs above the page.
//
// A click activates, a double click keeps a preview tab, a middle click closes, a drag moves the
// tab along the strip. A double click on a tab that is already kept renames it. Every tab inside
// a database names that database next to its title.
//
// Dragging works as in Chrome: the tab follows the pointer, the tabs it passes slide aside to open
// its place, and on release it settles into that place.
interface Drag {
    id: string;
    from: number;
    startX: number;
    // Where every tab stood when the drag began, in strip order. The slots are worked out from
    // these, not from the tabs as they slide, or a sliding tab would move the slot it is sliding to.
    lefts: number[];
    widths: number[];
    dx: number;
    // The index the tab would have if it were dropped now.
    target: number;
    // Until the pointer has moved a few pixels this is a click, not a drag.
    started: boolean;
}

const DRAG_THRESHOLD = 5;

export function TabBar() {
    const tabs = useTabs();
    const navigate = useNavigate();
    const strip = useRef<HTMLDivElement>(null);
    const active = tabs.active ? describeRoute(tabs.active.pathname) : undefined;

    // The drag is followed in a ref, which the window's pointer listeners read, and copied into
    // state to draw it.
    const dragRef = useRef<Drag | null>(null);
    const [drag, setDrag] = useState<Drag | null>(null);
    // A drag ends with a pointerup over the tab, and the browser follows it with a click that
    // must not count. Cleared on the next press, in case that click never came.
    const swallowClick = useRef(false);
    // Where the dropped tab was drawn at the moment of release, so it can glide from there into
    // its new place instead of jumping.
    const settle = useRef<{ id: string; left: number } | null>(null);
    const { activate, move } = tabs;

    // The tab whose name is being typed in, and what has been typed so far.
    const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

    const commitRename = () => {
        if (editing) {
            tabs.rename(editing.id, editing.text);
            setEditing(null);
        }
    };

    const onTabPointerDown = (e: ReactPointerEvent<HTMLDivElement>, tab: Tab, index: number) => {
        swallowClick.current = false;
        if (e.button !== 0 || editing?.id === tab.id || (e.target as Element).closest(".tab-close")) {
            return;
        }
        dragRef.current = { id: tab.id, from: index, startX: e.clientX, lefts: [], widths: [], dx: 0, target: index, started: false };
    };

    useEffect(() => {
        const onMove = (e: PointerEvent) => {
            const d = dragRef.current;
            if (!d) {
                return;
            }
            const dx = e.clientX - d.startX;
            if (!d.started) {
                if (Math.abs(dx) < DRAG_THRESHOLD) {
                    return;
                }
                const els = strip.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? [];
                const rects = Array.from(els, (el) => el.getBoundingClientRect());
                d.lefts = rects.map((r) => r.left);
                d.widths = rects.map((r) => r.width);
                d.started = true;
                // As in Chrome, the tab in hand is the active one.
                activate(d.id);
            }
            // The tab stays within the row of tabs: it cannot be pulled past the first or last.
            const last = d.lefts.length - 1;
            const minDx = d.lefts[0] - d.lefts[d.from];
            const maxDx = d.lefts[last] + d.widths[last] - (d.lefts[d.from] + d.widths[d.from]);
            d.dx = Math.min(maxDx, Math.max(minDx, dx));
            // A tab gives way once the dragged tab's leading edge passes its middle: the right
            // edge for the tabs to the right, the left edge for those to the left. Not the dragged
            // tab's middle: held back at the ends of the row, that only reaches the last tab's
            // middle and never passes it, so nothing could be moved to the end.
            const left = d.lefts[d.from] + d.dx;
            const right = left + d.widths[d.from];
            let target = d.from;
            for (let i = 0; i < d.lefts.length; i++) {
                const middle = d.lefts[i] + d.widths[i] / 2;
                if (i > d.from && right > middle) {
                    target++;
                } else if (i < d.from && left < middle) {
                    target--;
                }
            }
            d.target = target;
            setDrag({ ...d });
        };
        const onUp = () => {
            const d = dragRef.current;
            dragRef.current = null;
            if (!d?.started) {
                return;
            }
            swallowClick.current = true;
            settle.current = { id: d.id, left: d.lefts[d.from] + d.dx };
            if (d.target !== d.from) {
                // move() takes the tab to put it in front of, counted before it is taken out.
                move(d.id, d.target > d.from ? d.target + 1 : d.target);
            }
            setDrag(null);
        };
        const onCancel = () => {
            dragRef.current = null;
            setDrag(null);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onCancel);
        return () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onCancel);
        };
    }, [activate, move]);

    // The dropped tab is now in its new place in the strip. It starts drawn where it was let go
    // and glides the rest of the way.
    useLayoutEffect(() => {
        const s = settle.current;
        if (!s || drag) {
            return;
        }
        settle.current = null;
        const el = strip.current?.querySelector<HTMLElement>(`[data-tab-id="${s.id}"]`);
        if (!el) {
            return;
        }
        const delta = s.left - el.getBoundingClientRect().left;
        if (Math.abs(delta) > 0.5) {
            el.animate([{ transform: `translateX(${delta}px)` }, { transform: "translateX(0)" }], {
                duration: 150,
                easing: "ease-out",
            });
        }
    }, [drag, tabs.tabs]);

    // An active tab scrolled out of the strip is brought back into view. Not while a tab is
    // dragged: the drag measured the strip and the tabs must not scroll under it.
    useEffect(() => {
        if (dragRef.current?.started) {
            return;
        }
        strip.current?.querySelector<HTMLElement>(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }, [tabs.activeId]);

    const requestClose = (tab: Tab) => {
        if (tabs.isDirty(tab.id)) {
            const title = tab.name ?? describeRoute(tab.pathname).title;
            if (!window.confirm(`Close "${title}"? The SQL typed in it will be lost.`)) {
                return;
            }
        }
        tabs.close(tab.id);
    };

    // A new query starts on the database the active tab is on.
    const newQuery =
        active?.alias && active.db
            ? `/app/${encodeURIComponent(active.alias)}/${encodeURIComponent(active.db)}/query`
            : null;

    // Option/Alt+N opens one from anywhere, the SQL editor included. Not Cmd/Ctrl+N as in SSMS:
    // the browser keeps that for a new window and never hands it to the page. Taken in the capture
    // phase and stopped there, so the editor does not also type the "˜" a Mac's Option+N makes.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (isAltKey(e, "KeyN")) {
                e.preventDefault();
                e.stopPropagation();
                if (newQuery) {
                    navigate(newQuery);
                }
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [newQuery, navigate]);

    const newQueryKey = IS_MAC ? "⌥N" : "Alt+N";

    return (
        <div className={drag ? "tabbar reordering" : "tabbar"} role="tablist" ref={strip}>
            {tabs.tabs.map((tab, index) => {
                const route = describeRoute(tab.pathname);
                const isActive = tab.id === tabs.activeId;
                const busy = tabs.busy.has(tab.id);
                const dirty = tabs.isDirty(tab.id);
                // Every tab inside a database says which one, so two tabs of the same table on two
                // databases can be told apart. A database's own tab is already called by its name:
                // "Bpm Bpm" says nothing twice.
                const showDb = route.db && route.db !== route.title;
                const classes = ["tab"];
                if (isActive) {
                    classes.push("active");
                }
                if (tab.preview) {
                    classes.push("preview");
                }
                if (dirty) {
                    classes.push("dirty");
                }
                // The dragged tab follows the pointer. The tabs between its old place and its slot
                // slide one tab's width towards the place it left.
                let shift = 0;
                if (drag) {
                    const width = drag.widths[drag.from];
                    if (tab.id === drag.id) {
                        classes.push("dragging");
                        shift = drag.dx;
                    } else if (drag.from < index && index <= drag.target) {
                        shift = -width;
                    } else if (drag.target <= index && index < drag.from) {
                        shift = width;
                    }
                }
                const where = [route.alias, route.db].filter(Boolean).join(" / ");
                const title = tab.name ?? route.title;
                const isEditing = editing?.id === tab.id;
                // A renamed tab still says in its tooltip what it is.
                const tooltip = [where ? `${where} / ${route.title}` : route.title, tab.name && `"${tab.name}"`]
                    .filter(Boolean)
                    .join("  ·  ");
                return (
                    <div
                        key={tab.id}
                        className={classes.join(" ")}
                        role="tab"
                        aria-selected={isActive}
                        title={tooltip}
                        data-tab-id={tab.id}
                        style={shift ? { transform: `translateX(${shift}px)` } : undefined}
                        onPointerDown={(e) => onTabPointerDown(e, tab, index)}
                        onClick={() => {
                            if (swallowClick.current) {
                                swallowClick.current = false;
                                return;
                            }
                            tabs.activate(tab.id);
                        }}
                        onDoubleClick={() => {
                            if (tab.preview) {
                                tabs.pin(tab.id);
                            } else {
                                setEditing({ id: tab.id, text: title });
                            }
                        }}
                        onMouseDown={(e) => {
                            // Without this the middle button starts the browser's autoscroll.
                            if (e.button === 1) {
                                e.preventDefault();
                            }
                        }}
                        onAuxClick={(e) => {
                            if (e.button === 1) {
                                e.preventDefault();
                                requestClose(tab);
                            }
                        }}
                    >
                        <span className="tab-icon">
                            {busy ? <span className="tab-spinner" aria-label="running" /> : route.icon && <Icon name={route.icon} size={14} />}
                        </span>
                        {isEditing ? (
                            <input
                                className="tab-rename"
                                autoFocus
                                value={editing.text}
                                size={Math.max(editing.text.length, 4)}
                                placeholder={route.title}
                                aria-label="Tab name"
                                onFocus={(e) => e.currentTarget.select()}
                                onChange={(e) => setEditing({ id: tab.id, text: e.target.value })}
                                onBlur={commitRename}
                                onKeyDown={(e) => {
                                    e.stopPropagation();
                                    if (e.key === "Enter") {
                                        commitRename();
                                    } else if (e.key === "Escape") {
                                        setEditing(null);
                                    }
                                }}
                                onClick={(e) => e.stopPropagation()}
                                onDoubleClick={(e) => e.stopPropagation()}
                                onMouseDown={(e) => e.stopPropagation()}
                            />
                        ) : (
                            <span className="tab-title">{title}</span>
                        )}
                        {showDb && <span className="tab-db">{route.db}</span>}
                        <button
                            type="button"
                            className="tab-close"
                            aria-label={`Close ${title}`}
                            title={dirty ? "Has unsaved SQL" : "Close"}
                            onClick={(e) => {
                                e.stopPropagation();
                                requestClose(tab);
                            }}
                            onDoubleClick={(e) => e.stopPropagation()}
                        >
                            <span className="tab-dot" />
                            <Icon name="x" size={13} label="close" />
                        </button>
                    </div>
                );
            })}
            <button
                type="button"
                className="tab-new"
                disabled={!newQuery}
                title={newQuery ? `New query on ${active?.db} (${newQueryKey})` : "Open a database to start a query"}
                onClick={() => newQuery && navigate(newQuery)}
            >
                <Icon name="plus" size={15} label="new query" />
            </button>
        </div>
    );
}
