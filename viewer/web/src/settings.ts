import { useSyncExternalStore } from "react";

// The user's settings. Kept in this browser only: they are working preferences, and someone who
// opens the same server through a tunnel should not inherit (or overwrite) them.
//
// Only the values that differ from the default are stored. A default that changes in a later
// version then reaches everyone who never touched that setting, which is what a default is for.

const STORE_KEY = "sqlbrowser.settings";

interface Base {
    id: string;
    // The category in the settings tree; " › " separates a sub-category ("Lists › Tables").
    section: string;
    title: string;
    description: string;
}

export interface ChoiceSetting extends Base {
    kind: "choice";
    options: { value: string; label: string }[];
    default: string;
}

export interface NumberSetting extends Base {
    kind: "number";
    min: number;
    max: number;
    default: number;
}

export interface BooleanSetting extends Base {
    kind: "boolean";
    default: boolean;
}

export type Setting = ChoiceSetting | NumberSetting | BooleanSetting;

// A list's sort is stored as "column:asc" or "column:desc", the column being DataTable's key.
function sortOption(column: string, desc: boolean, label: string) {
    return { value: `${column}:${desc ? "desc" : "asc"}`, label };
}

export const SETTINGS = [
    {
        id: "appearance.theme",
        section: "Appearance",
        title: "Theme",
        description: "Light or dark colours. System follows the operating system and switches along with it.",
        kind: "choice",
        options: [
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
        ],
        default: "system",
    },
    {
        id: "editor.fontSize",
        section: "Editor",
        title: "Font Size",
        description: "Font size of the query editor and the SQL previews, in pixels.",
        kind: "number",
        min: 9,
        max: 24,
        default: 12,
    },
    {
        id: "editor.lineNumbers",
        section: "Editor",
        title: "Line Numbers",
        description: "Show line numbers on the left edge of the editor.",
        kind: "boolean",
        default: false,
    },
    {
        id: "editor.wordWrap",
        section: "Editor",
        title: "Word Wrap",
        description: "Wrap long lines at the edge of the editor instead of scrolling sideways.",
        kind: "boolean",
        default: true,
    },
    {
        id: "editor.minimap",
        section: "Editor",
        title: "Minimap",
        description: "Show the minimap on the right edge of the editor.",
        kind: "boolean",
        default: false,
    },
    {
        id: "grid.dateFormat",
        section: "Result Grid",
        title: "Date Format",
        description:
            "How date and datetime values are shown. Copying always writes the year-first form, which every spreadsheet reads the same way.",
        kind: "choice",
        options: [
            { value: "iso", label: "2026-11-02 15:16:00" },
            { value: "dmy", label: "02.11.2026 15:16:00" },
        ],
        default: "iso",
    },
    {
        id: "grid.fractionalSeconds",
        section: "Result Grid",
        title: "Fractional Seconds",
        description: "Show the part of a time value below a second, in a fainter colour.",
        kind: "boolean",
        default: true,
    },
    {
        id: "lists.tables.sort",
        section: "Lists › Tables",
        title: "Default Sort",
        description: "The order the table lists open in. Clicking a column header still re-sorts.",
        kind: "choice",
        options: [
            sortOption("reserved", true, "Allocated, largest first"),
            sortOption("rows", true, "Rows, most first"),
            sortOption("name", false, "Name, A to Z"),
            sortOption("schema", false, "Schema, A to Z"),
        ],
        default: "reserved:desc",
    },
    {
        id: "lists.databases.sort",
        section: "Lists › Databases",
        title: "Default Sort",
        description: "The order a server's database list opens in.",
        kind: "choice",
        options: [sortOption("data", true, "Data size, largest first"), sortOption("name", false, "Name, A to Z")],
        default: "data:desc",
    },
    {
        id: "lists.objects.sort",
        section: "Lists › Objects",
        title: "Default Sort",
        description: "The order the view, procedure, function and other object lists open in.",
        kind: "choice",
        options: [
            sortOption("name", false, "Name, A to Z"),
            sortOption("schema", false, "Schema, A to Z"),
            sortOption("modified", true, "Modified, newest first"),
        ],
        default: "name:asc",
    },
    {
        id: "lists.schemas.sort",
        section: "Lists › Schemas",
        title: "Default Sort",
        description: "The order the schema list opens in.",
        kind: "choice",
        options: [sortOption("tables", true, "Tables, most first"), sortOption("name", false, "Name, A to Z")],
        default: "tables:desc",
    },
    {
        id: "pivot.limit",
        section: "Pivot",
        title: "Group Limit",
        description:
            "How many row groups a pivot returns at most. The server does not go above 1000. With column fields the server's own limit of 10,000 cells applies instead.",
        kind: "number",
        min: 1,
        max: 1000,
        default: 1000,
    },
    {
        id: "pivot.autoRun",
        section: "Pivot",
        title: "Run On Every Change",
        description: "Run the pivot again by itself, shortly after a field is moved or a filter changes, instead of waiting for Run.",
        kind: "boolean",
        default: false,
    },
    {
        id: "scripting.warnRows",
        section: "Scripting",
        title: "Warn Above Rows",
        description:
            "When scripting data, tables bigger than this get a warning that 'all' is probably not what you want.",
        kind: "number",
        min: 1,
        max: 100000,
        default: 1000,
    },
] as const satisfies readonly Setting[];

export type SettingId = (typeof SETTINGS)[number]["id"];

type ValueOf<S> = S extends { kind: "number" } ? number : S extends { kind: "boolean" } ? boolean : string;
export type SettingValue<K extends SettingId> = ValueOf<Extract<(typeof SETTINGS)[number], { id: K }>>;

const byId = new Map<string, Setting>(SETTINGS.map((s) => [s.id, s]));

// ---------------------------------------------------------------- store

type Stored = Record<string, string | number | boolean>;

function load(): Stored {
    try {
        const parsed = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
        return parsed && typeof parsed === "object" ? (parsed as Stored) : {};
    } catch {
        return {};
    }
}

let stored: Stored = load();
const listeners = new Set<() => void>();

function notify(): void {
    listeners.forEach((listener) => listener());
}

// Another tab changed them: this one follows, so two open tabs never disagree for long.
window.addEventListener("storage", (event) => {
    if (event.key === STORE_KEY) {
        stored = load();
        notify();
    }
});

// A stored value is used only when it still fits the setting. An option removed in a later
// version, or a hand-edited entry, falls back to the default instead of breaking a page.
function valid(setting: Setting, value: unknown): boolean {
    switch (setting.kind) {
        case "choice":
            return setting.options.some((o) => o.value === value);
        case "number":
            return typeof value === "number" && Number.isInteger(value) && value >= setting.min && value <= setting.max;
        case "boolean":
            return typeof value === "boolean";
    }
}

export function getSetting<K extends SettingId>(id: K): SettingValue<K> {
    const setting = byId.get(id)!;
    const value = stored[id];
    return (valid(setting, value) ? value : setting.default) as SettingValue<K>;
}

export function isModified(id: SettingId): boolean {
    return id in stored && valid(byId.get(id)!, stored[id]);
}

export function setSetting<K extends SettingId>(id: K, value: SettingValue<K>): void {
    const setting = byId.get(id)!;
    if (!valid(setting, value)) {
        return;
    }
    const next = { ...stored };
    if (value === setting.default) {
        delete next[id];
    } else {
        next[id] = value;
    }
    stored = next;
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(stored));
    } catch {
        // Storage is off (a private window, say): the setting holds until the page is reloaded.
    }
    notify();
}

export function resetSetting(id: SettingId): void {
    setSetting(id, byId.get(id)!.default as SettingValue<typeof id>);
}

export function subscribeSettings(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useSetting<K extends SettingId>(id: K): SettingValue<K> {
    return useSyncExternalStore(subscribeSettings, () => getSetting(id));
}

// "reserved:desc" -> the shape DataTable's initialSort takes.
export function useSortSetting(id: SettingId): { key: string; desc: boolean } {
    const [key, direction] = String(useSetting(id)).split(":");
    return { key, desc: direction === "desc" };
}
