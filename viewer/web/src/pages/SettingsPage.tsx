import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
    SETTINGS,
    isModified,
    resetSetting,
    setSetting,
    useSetting,
    type ListSetting,
    type NumberSetting,
    type Setting,
    type SettingId,
} from "../settings";

// Laid out after VS Code's settings editor: one search box, the categories on the left, every
// setting in one scrolling list on the right. There is no Save button: a change applies at once
// and a setting that differs from its default is marked, so what you changed is never a mystery.

type Entry = (typeof SETTINGS)[number];

interface Group {
    section: string;
    entries: Entry[];
}

function top(section: string): string {
    return section.split(" › ")[0];
}

function anchorFor(section: string): string {
    return "settings-" + section.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function matches(setting: Setting, words: string[]): boolean {
    const haystack = `${setting.section} ${setting.title} ${setting.description} ${setting.id}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
}

export function SettingsPage() {
    const [search, setSearch] = useState("");
    const [active, setActive] = useState<string>(SETTINGS[0].section);
    const sections = useRef(new Map<string, HTMLElement>());
    const page = useRef<HTMLDivElement>(null);
    const head = useRef<HTMLDivElement>(null);
    // Where the list's content starts on screen once the search header has stuck: the breadcrumb
    // bar plus the header. Headings are scrolled to it and measured against it.
    const stuckBottom = useRef(0);

    // The search header sticks under the breadcrumb bar, as VS Code's does, so jumping to a
    // category never scrolls the search box away. Both heights are measured rather than written
    // into the stylesheet: the breadcrumb wraps on a narrow window and the header's height follows.
    useLayoutEffect(() => {
        const crumbs = document.querySelector<HTMLElement>(".crumbs");
        const measure = () => {
            const top = crumbs?.offsetHeight ?? 0;
            const height = head.current?.offsetHeight ?? 0;
            stuckBottom.current = top + height;
            page.current?.style.setProperty("--settings-top", `${top}px`);
            page.current?.style.setProperty("--settings-head", `${height}px`);
        };
        measure();
        const observer = new ResizeObserver(measure);
        [crumbs, head.current].forEach((element) => element && observer.observe(element));
        return () => observer.disconnect();
    }, []);

    const words = useMemo(() => search.trim().toLowerCase().split(/\s+/).filter(Boolean), [search]);
    const shown = useMemo(() => SETTINGS.filter((s) => matches(s, words)), [words]);

    const groups = useMemo(() => {
        const list: Group[] = [];
        for (const entry of shown) {
            const last = list[list.length - 1];
            if (last?.section === entry.section) {
                last.entries.push(entry);
            } else {
                list.push({ section: entry.section, entries: [entry] });
            }
        }
        return list;
    }, [shown]);

    // The tree lists every category, not just the matching ones: it is the map of what exists.
    const tree = useMemo(() => {
        const result: { section: string; depth: number }[] = [];
        for (const { section } of SETTINGS) {
            const parent = top(section);
            if (!result.some((n) => n.section === parent)) {
                result.push({ section: parent, depth: 0 });
            }
            if (section !== parent && !result.some((n) => n.section === section)) {
                result.push({ section, depth: 1 });
            }
        }
        return result;
    }, []);

    // The tree follows the scroll: the highlighted category is the one whose heading last passed
    // under the sticky search header.
    useEffect(() => {
        const onScroll = () => {
            let current = groups[0]?.section;
            for (const group of groups) {
                const element = sections.current.get(group.section);
                if (element && element.getBoundingClientRect().top < stuckBottom.current + 30) {
                    current = group.section;
                }
            }
            if (current) {
                setActive(current);
            }
        };
        onScroll();
        window.addEventListener("scroll", onScroll, { passive: true });
        return () => window.removeEventListener("scroll", onScroll);
    }, [groups]);

    const jump = (section: string) => {
        // A parent category with no settings of its own ("Lists") jumps to its first child.
        const target = groups.find((g) => g.section === section || top(g.section) === section);
        const element = target && sections.current.get(target.section);
        if (element) {
            window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - stuckBottom.current - 8, behavior: "smooth" });
        }
    };

    return (
        <div className="settings" ref={page}>
            <div className="settings-head" ref={head}>
                <div className="settings-search">
                    <input
                        type="search"
                        placeholder="Search settings"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        autoFocus
                    />
                    <span className="ratio">
                        {words.length ? `${shown.length} of ${SETTINGS.length}` : SETTINGS.length} settings
                    </span>
                </div>
                <div className="settings-scope">
                    <span className="on">This browser</span>
                    <span className="muted">Saved automatically</span>
                </div>
            </div>

            <div className="settings-body">
                <nav className="settings-tree" aria-label="Setting categories">
                    {tree.map((node) => {
                        const on = active === node.section || (node.depth === 0 && top(active) === node.section);
                        const empty = !groups.some((g) => g.section === node.section || top(g.section) === node.section);
                        return (
                            <button
                                key={node.section}
                                type="button"
                                className={["node", `depth${node.depth}`, on ? "on" : "", empty ? "empty" : ""].join(" ")}
                                onClick={() => jump(node.section)}
                                disabled={empty}
                            >
                                {node.depth ? node.section.split(" › ")[1] : node.section}
                            </button>
                        );
                    })}
                </nav>

                <main className="settings-list">
                    {groups.length === 0 && <div className="state">No settings match '{search.trim()}'.</div>}
                    {groups.map((group, index) => {
                        const isSub = group.section.includes(" › ");
                        // A sub-category under a parent that has not been titled yet gets the
                        // parent's heading first, so "Tables" never appears without "Lists".
                        const parentTitled = index > 0 && top(groups[index - 1].section) === top(group.section);
                        return (
                            <section
                                key={group.section}
                                id={anchorFor(group.section)}
                                ref={(element) => {
                                    if (element) {
                                        sections.current.set(group.section, element);
                                    } else {
                                        sections.current.delete(group.section);
                                    }
                                }}
                            >
                                {(!isSub || !parentTitled) && <h2>{top(group.section)}</h2>}
                                {isSub && <h3>{group.section.split(" › ")[1]}</h3>}
                                {group.entries.map((entry) => (
                                    <SettingRow key={entry.id} setting={entry} />
                                ))}
                            </section>
                        );
                    })}
                </main>
            </div>
        </div>
    );
}

function SettingRow({ setting }: { setting: Entry }) {
    const value = useSetting(setting.id as SettingId);
    // Read through the store's subscription above; isModified itself is not reactive.
    const modified = isModified(setting.id);
    const control = `setting-${setting.id}`;

    return (
        <div className={modified ? "setting modified" : "setting"}>
            <div className="setting-title">
                <span className="category">{setting.section}: </span>
                <label htmlFor={control}>{setting.title}</label>
                {modified && (
                    <>
                        <span className="badge">Modified</span>
                        <button type="button" className="link-button" onClick={() => resetSetting(setting.id)}>
                            Reset
                        </button>
                    </>
                )}
            </div>

            {setting.kind === "boolean" ? (
                <label className="setting-check">
                    <input
                        id={control}
                        type="checkbox"
                        checked={value as boolean}
                        onChange={(e) => setSetting(setting.id, e.target.checked as never)}
                    />
                    <span className="setting-desc">{setting.description}</span>
                </label>
            ) : (
                <>
                    <div className="setting-desc">{setting.description}</div>
                    {setting.kind === "choice" ? (
                        <select
                            id={control}
                            value={value as string}
                            onChange={(e) => setSetting(setting.id, e.target.value as never)}
                        >
                            {setting.options.map((option) => (
                                <option key={option.value} value={option.value}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                    ) : setting.kind === "number" ? (
                        <NumberInput id={control} setting={setting} value={value as number} />
                    ) : (
                        <ListInput id={control} setting={setting} value={value as readonly string[]} />
                    )}
                </>
            )}
        </div>
    );
}

// While a number is being typed the field shows the draft, not the setting: on the way to "14"
// it must show "1", but the editor should not jump to a 1-pixel font. Only a valid number is
// saved. Outside typing the field shows the setting itself, so a Reset or another tab's change
// appears at once.
function NumberInput({ id, setting, value }: { id: string; setting: NumberSetting; value: number }) {
    const [draft, setDraft] = useState<string | null>(null);
    const text = draft ?? String(value);
    const parsed = Number(text);
    const valid = text.trim() !== "" && Number.isInteger(parsed) && parsed >= setting.min && parsed <= setting.max;

    return (
        <div className="setting-number">
            <input
                id={id}
                type="number"
                min={setting.min}
                max={setting.max}
                value={text}
                aria-invalid={!valid}
                onChange={(e) => {
                    setDraft(e.target.value);
                    const next = Number(e.target.value);
                    if (e.target.value.trim() !== "" && Number.isInteger(next) && next >= setting.min && next <= setting.max) {
                        setSetting(setting.id as SettingId, next as never);
                    }
                }}
                onBlur={() => setDraft(null)}
            />
            {!valid && (
                <span className="setting-error">
                    A whole number from {setting.min.toLocaleString("en-US")} to {setting.max.toLocaleString("en-US")}.
                </span>
            )}
        </div>
    );
}

// As VS Code edits a string array: the items one per line, each with its own remove button, and
// a field below for the next one. Enter adds, so a few patterns go in without touching the mouse.
// Blanks and repeats (in any case, since matching ignores it) are not added.
function ListInput({ id, setting, value }: { id: string; setting: ListSetting; value: readonly string[] }) {
    const [draft, setDraft] = useState("");
    const item = draft.trim();
    const repeat = value.some((v) => v.toLowerCase() === item.toLowerCase());

    const add = () => {
        if (item && !repeat) {
            setSetting(setting.id as SettingId, [...value, item] as never);
            setDraft("");
        }
    };

    return (
        <div className="setting-list">
            {value.length > 0 && (
                <ul>
                    {value.map((entry, index) => (
                        <li key={entry}>
                            <span className="mono">{entry}</span>
                            <button
                                type="button"
                                className="setting-remove"
                                title={`Remove ${entry}`}
                                aria-label={`Remove ${entry}`}
                                onClick={() =>
                                    setSetting(setting.id as SettingId, value.filter((_, i) => i !== index) as never)
                                }
                            >
                                ×
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <div className="setting-list-add">
                <input
                    id={id}
                    type="text"
                    className="mono"
                    placeholder={setting.placeholder}
                    value={draft}
                    aria-invalid={repeat && item !== ""}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            add();
                        }
                    }}
                />
                <button type="button" onClick={add} disabled={!item || repeat}>
                    Add
                </button>
                {repeat && item !== "" && <span className="setting-error">Already in the list.</span>}
            </div>
        </div>
    );
}
