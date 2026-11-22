import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";

import { Icon } from "../Icon";
import { describeRoute } from "./tabRoute";
import { useTabs, type Tab } from "./TabStore";

// The strip of open tabs above the page.
//
// A click activates, a double click keeps a preview tab, a middle click closes. Every tab inside a
// database names that database next to its title.
export function TabBar() {
    const tabs = useTabs();
    const navigate = useNavigate();
    const strip = useRef<HTMLDivElement>(null);
    const active = tabs.active ? describeRoute(tabs.active.pathname) : undefined;

    // An active tab scrolled out of the strip is brought back into view.
    useEffect(() => {
        strip.current?.querySelector<HTMLElement>(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }, [tabs.activeId]);

    const requestClose = (tab: Tab) => {
        if (tabs.isDirty(tab.id)) {
            const title = describeRoute(tab.pathname).title;
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

    return (
        <div className="tabbar" role="tablist" ref={strip}>
            {tabs.tabs.map((tab) => {
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
                const where = [route.alias, route.db].filter(Boolean).join(" / ");
                return (
                    <div
                        key={tab.id}
                        className={classes.join(" ")}
                        role="tab"
                        aria-selected={isActive}
                        title={where ? `${where} / ${route.title}` : route.title}
                        onClick={() => tabs.activate(tab.id)}
                        onDoubleClick={() => tabs.pin(tab.id)}
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
                        <span className="tab-title">{route.title}</span>
                        {showDb && <span className="tab-db">{route.db}</span>}
                        <button
                            type="button"
                            className="tab-close"
                            aria-label={`Close ${route.title}`}
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
                title={newQuery ? `New query on ${active?.db}` : "Open a database to start a query"}
                onClick={() => newQuery && navigate(newQuery)}
            >
                <Icon name="plus" size={15} label="new query" />
            </button>
        </div>
    );
}
