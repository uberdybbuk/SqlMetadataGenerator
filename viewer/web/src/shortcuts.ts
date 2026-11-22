// The application's keyboard shortcuts: how a key is spelled on this machine, and the one list
// the help popup reads, so a shortcut that is added in code and left out of the list is easy to see.

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// "⌘" on a Mac, "Ctrl+" elsewhere: "⌘B" next to "Ctrl+B".
export const MOD = IS_MAC ? "⌘" : "Ctrl+";

// Cmd on a Mac, Ctrl elsewhere, with nothing else held. Matched on e.key so it follows the
// keyboard layout, the way VS Code and SSMS read it.
export function isModKey(e: KeyboardEvent, key: string): boolean {
    const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    return mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === key;
}

// Option on a Mac, Alt elsewhere, with nothing else held. Matched on e.code, the physical key:
// on a Mac Option turns the letter into another character (⌥N is a dead key for "˜"), so e.key
// never says "n".
export function isAltKey(e: KeyboardEvent, code: string): boolean {
    return e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === code;
}

// Typing into these is not a request for an application shortcut: "?" in a WHERE box is a
// question mark.
export function isTyping(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || !!el.closest(".monaco-editor"));
}

// Asks the help popup to open, from a button anywhere on the page.
export const OPEN_SHORTCUTS_EVENT = "sqlbrowser:shortcuts";

export function openShortcuts(): void {
    window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT));
}

export interface ShortcutGroup {
    title: string;
    items: { keys: string[]; label: string }[];
}

// Each entry in keys is one way to press it: ["F5", "Alt+X"] means either.
export const SHORTCUTS: ShortcutGroup[] = [
    {
        title: "General",
        items: [
            { keys: ["?"], label: "Show this list" },
            { keys: [`${MOD}B`], label: "Show or hide the object tree" },
            { keys: [`${MOD}P`], label: "Filter the object tree" },
            { keys: [`${MOD}U`], label: "Change the database" },
            { keys: [IS_MAC ? "⌥N" : "Alt+N"], label: "New query on the current database" },
        ],
    },
    {
        title: "Query editor",
        items: [
            { keys: ["F5", IS_MAC ? "⌥X" : "Alt+X"], label: "Execute (the selection alone when there is one)" },
            { keys: ["Esc"], label: "Cancel the running query" },
            { keys: [`${MOD}R`], label: "Show or hide the results" },
            { keys: [`${MOD}K ${MOD}C`], label: "Comment out" },
            { keys: [`${MOD}K ${MOD}U`], label: "Uncomment" },
            { keys: [`${MOD}/`], label: "Toggle comment" },
        ],
    },
    {
        title: "Object tree",
        items: [
            { keys: ["↑", "↓"], label: "Move" },
            { keys: ["→", "←"], label: "Expand, collapse" },
            { keys: ["Enter"], label: "Open" },
            { keys: ["Space"], label: "Expand or collapse" },
        ],
    },
];
