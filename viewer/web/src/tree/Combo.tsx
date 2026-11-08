import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import { Icon, type IconName } from "../Icon";

// The server and database pickers at the top of the object tree. A native select cannot filter
// thirty databases or show their sizes, so this draws its own list.
//
// An item is a real link, so Cmd-click opens that database in a new tab, as a tree row does. An
// item with no link only closes the list: picking the place you are already in goes nowhere.

export interface ComboItem {
    key: string;
    label: string;
    icon?: IconName;
    href?: string;
    // Faint text on the right: a database's size.
    meta?: string;
    // A framed label on the right: a connection's engine.
    badge?: string;
    current?: boolean;
    disabled?: boolean;
    // An action rather than a choice ("New connection"): written like a link, not like a name.
    action?: boolean;
}

export interface ComboSection {
    key: string;
    title?: string;
    items: ComboItem[];
    // The link on the right of the section's heading.
    link?: { label: string; run: () => void };
}

interface ComboProps {
    label: string;
    icon: IconName;
    value: string | null;
    placeholder: string;
    meta?: string;
    // The server's picker reads as the tree's title; only the database's looks like a field.
    plain?: boolean;
    // Without it the list has no filter box: a handful of connections does not need one.
    searchPlaceholder?: string;
    sections: (query: string) => ComboSection[];
    // Shown in place of the list when it has nothing to offer.
    emptyText: string;
    keysHint?: boolean;
    onOpen?: () => void;
}

export function Combo({ label, icon, value, placeholder, meta, plain, searchPlaceholder, sections, emptyText, keysHint, onOpen }: ComboProps) {
    const navigate = useNavigate();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [active, setActive] = useState(0);
    const root = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const options = useRef<HTMLDivElement>(null);

    const shown = open ? sections(query.trim().toLowerCase()) : [];
    const selectable = shown.flatMap((section) => section.items).filter((item) => !item.disabled);

    const show = () => {
        // Starts on the current item, so the arrow keys move from where you are.
        const start = sections("").flatMap((section) => section.items).filter((item) => !item.disabled).findIndex((item) => item.current);
        setQuery("");
        setActive(Math.max(0, start));
        setOpen(true);
        onOpen?.();
    };

    const close = () => {
        setOpen(false);
    };

    const pick = (item: ComboItem) => {
        close();
        trigger.current?.focus();
        if (item.href) {
            navigate(item.href);
        }
    };

    // Clicking anywhere else closes it. On pointerdown, so the same click can already land on
    // what was under the list.
    useEffect(() => {
        if (!open) {
            return;
        }
        const onDown = (e: PointerEvent) => {
            if (!root.current?.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener("pointerdown", onDown);
        return () => document.removeEventListener("pointerdown", onDown);
    }, [open]);

    // With no filter box the keys still have to reach the list.
    useLayoutEffect(() => {
        if (open && !searchPlaceholder) {
            options.current?.focus();
        }
    }, [open, searchPlaceholder]);

    useLayoutEffect(() => {
        if (open) {
            options.current?.querySelector<HTMLElement>(".combo-item.active")?.scrollIntoView({ block: "nearest" });
        }
    }, [open, active, query]);

    const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
        if (!open) {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                show();
            }
            return;
        }
        const count = selectable.length;
        switch (e.key) {
            case "ArrowDown":
                setActive(count ? (active + 1) % count : 0);
                break;
            case "ArrowUp":
                setActive(count ? (active - 1 + count) % count : 0);
                break;
            case "Enter":
                if (selectable[active]) {
                    pick(selectable[active]);
                }
                break;
            case "Escape":
                close();
                trigger.current?.focus();
                break;
            case "Tab":
                close();
                return;
            default:
                return;
        }
        e.preventDefault();
    };

    const activeItem = selectable[active];

    return (
        <div className="combo-root" ref={root} onKeyDown={onKey}>
            <button
                type="button"
                ref={trigger}
                className={["combo", plain ? "plain" : "", open ? "open" : ""].join(" ")}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={label}
                title={value ?? undefined}
                onClick={() => (open ? close() : show())}
            >
                <Icon name={icon} size={plain ? 15 : 14} />
                {value ? <span className="combo-name mono">{value}</span> : <span className="combo-placeholder">{placeholder}</span>}
                {meta && <span className="combo-meta">{meta}</span>}
                <span className="combo-caret">▾</span>
            </button>

            {open && (
                <div className="combo-pop">
                    {searchPlaceholder && (
                        <div className="combo-search">
                            <Icon name="search" size={13} />
                            <input
                                type="text"
                                autoFocus
                                placeholder={searchPlaceholder}
                                value={query}
                                aria-label={searchPlaceholder}
                                onChange={(e) => {
                                    setQuery(e.target.value);
                                    setActive(0);
                                }}
                            />
                        </div>
                    )}

                    <div className="combo-options" ref={options} role="listbox" aria-label={label} tabIndex={-1}>
                        {selectable.length === 0 && <div className="combo-empty">{emptyText}</div>}
                        {shown.map((section) => (
                            <div className="combo-section" key={section.key}>
                                {section.title && (
                                    <div className="combo-heading">
                                        <span>{section.title}</span>
                                        {section.link && (
                                            <button type="button" onClick={section.link.run}>
                                                {section.link.label}
                                            </button>
                                        )}
                                    </div>
                                )}
                                {section.items.map((item) => {
                                    const classes = ["combo-item"];
                                    if (item === activeItem) {
                                        classes.push("active");
                                    }
                                    if (item.current) {
                                        classes.push("current");
                                    }
                                    if (item.disabled) {
                                        classes.push("disabled");
                                    }
                                    if (item.action) {
                                        classes.push("action");
                                    }
                                    const body = (
                                        <>
                                            {item.icon && <Icon name={item.icon} size={14} />}
                                            <span className="combo-label">{item.label}</span>
                                            {item.meta && <span className="combo-meta">{item.meta}</span>}
                                            {item.badge && <span className="combo-badge">{item.badge}</span>}
                                        </>
                                    );
                                    const shared = {
                                        className: classes.join(" "),
                                        role: "option",
                                        "aria-selected": item.current === true,
                                        "aria-disabled": item.disabled === true,
                                        title: item.label,
                                        // On move, not enter: a list scrolled by the keys slides
                                        // under a still mouse, which must not take the highlight.
                                        onMouseMove: () => {
                                            if (!item.disabled) {
                                                setActive(selectable.indexOf(item));
                                            }
                                        },
                                    };
                                    return item.href && !item.disabled ? (
                                        <Link key={item.key} {...shared} to={item.href} tabIndex={-1} onClick={close}>
                                            {body}
                                        </Link>
                                    ) : (
                                        <div key={item.key} {...shared} onClick={item.disabled ? undefined : close}>
                                            {body}
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                    </div>

                    {keysHint && <div className="combo-keys">↑↓ move · ↵ open · esc close</div>}
                </div>
            )}
        </div>
    );
}
