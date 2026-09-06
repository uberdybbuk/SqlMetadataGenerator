import type { SVGProps } from "react";

// Icon bodies taken from Tabler Icons (MIT, https://tabler.io/icons).
// The 14 icons in use are embedded instead of depending on the package: nothing is added to
// the bundle, and when the set changes is up to us.
//
// They all draw with currentColor, so an icon takes the colour of the text around it and
// light/dark mode needs nothing extra.

export type IconName =
    | "server"
    | "database"
    | "schema"
    | "table"
    | "view"
    | "procedure"
    | "function"
    | "trigger"
    | "synonym"
    | "sequence"
    | "type"
    | "column"
    | "key"
    | "search"
    | "play"
    | "stop";

const PATHS: Record<IconName, string> = {
    "play": '<path d="M7 4v16l13 -8z" />',
    "stop": '<path d="M5 5m0 2a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2z" />',
    "server":
        '<path d="M3 7a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-2" /> <path d="M3 15a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3l0 -2" /> <path d="M7 8l0 .01" /> <path d="M7 16l0 .01" />',
    "database":
        '<path d="M4 6a8 3 0 1 0 16 0a8 3 0 1 0 -16 0" /> <path d="M4 6v6a8 3 0 0 0 16 0v-6" /> <path d="M4 12v6a8 3 0 0 0 16 0v-6" />',
    "schema":
        '<path d="M5 2h5v4h-5l0 -4" /> <path d="M15 10h5v4h-5l0 -4" /> <path d="M5 18h5v4h-5l0 -4" /> <path d="M5 10h5v4h-5l0 -4" /> <path d="M10 12h5" /> <path d="M7.5 6v4" /> <path d="M7.5 14v4" />',
    "table":
        '<path d="M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14" /> <path d="M3 10h18" /> <path d="M10 3v18" />',
    "view":
        '<path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0" /> <path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6" />',
    "procedure":
        '<path d="M12 8a2 2 0 0 1 2 2v4a2 2 0 1 1 -4 0v-4a2 2 0 0 1 2 -2" /> <path d="M17 8v8h4" /> <path d="M13 15l1 1" /> <path d="M3 15a1 1 0 0 0 1 1h2a1 1 0 0 0 1 -1v-2a1 1 0 0 0 -1 -1h-2a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1" />',
    "function":
        '<path d="M4 6.667a2.667 2.667 0 0 1 2.667 -2.667h10.666a2.667 2.667 0 0 1 2.667 2.667v10.666a2.667 2.667 0 0 1 -2.667 2.667h-10.666a2.667 2.667 0 0 1 -2.667 -2.667l0 -10.666" /> <path d="M9 15.5v.25c0 .69 .56 1.25 1.25 1.25c.71 0 1.304 -.538 1.374 -1.244l.752 -7.512a1.381 1.381 0 0 1 1.374 -1.244c.69 0 1.25 .56 1.25 1.25v.25" /> <path d="M9 12h6" />',
    "trigger":
        '<path d="M13 3l0 7l6 0l-8 11l0 -7l-6 0l8 -11" />',
    "synonym":
        '<path d="M3 12v-7a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-7" /> <path d="M3 10h18" /> <path d="M10 3v10" /> <path d="M2 17a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-4" />',
    "sequence":
        '<path d="M11 6h9" /> <path d="M11 12h9" /> <path d="M12 18h8" /> <path d="M4 16a2 2 0 1 1 4 0c0 .591 -.5 1 -1 1.5l-3 2.5h4" /> <path d="M6 10v-6l-2 2" />',
    "type":
        '<path d="M7 4a2 2 0 0 0 -2 2v3a2 3 0 0 1 -2 3a2 3 0 0 1 2 3v3a2 2 0 0 0 2 2" /> <path d="M17 4a2 2 0 0 1 2 2v3a2 3 0 0 0 2 3a2 3 0 0 0 -2 3v3a2 2 0 0 1 -2 2" />',
    "column":
        '<path d="M4 6l5.5 0" /> <path d="M4 10l5.5 0" /> <path d="M4 14l5.5 0" /> <path d="M4 18l5.5 0" /> <path d="M14.5 6l5.5 0" /> <path d="M14.5 10l5.5 0" /> <path d="M14.5 14l5.5 0" /> <path d="M14.5 18l5.5 0" />',
    "key":
        '<path d="M16.555 3.843l3.602 3.602a2.877 2.877 0 0 1 0 4.069l-2.643 2.643a2.877 2.877 0 0 1 -4.069 0l-.301 -.301l-6.558 6.558a2 2 0 0 1 -1.239 .578l-.175 .008h-1.172a1 1 0 0 1 -.993 -.883l-.007 -.117v-1.172a2 2 0 0 1 .467 -1.284l.119 -.13l.414 -.414h2v-2h2v-2l2.144 -2.144l-.301 -.301a2.877 2.877 0 0 1 0 -4.069l2.643 -2.643a2.877 2.877 0 0 1 4.069 0" /> <path d="M15 9h.01" />',
    "search":
        '<path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" /> <path d="M21 21l-6 -6" />',
};

// The labels map to the same concepts as the ObjectFilter.ValidTypes vocabulary.
export const ICON_LABELS: Record<IconName, string> = {
    server: "server",
    database: "database",
    schema: "schema",
    table: "table",
    view: "view",
    procedure: "procedure",
    function: "function",
    trigger: "trigger",
    synonym: "synonym",
    sequence: "sequence",
    type: "type",
    column: "column",
    key: "key",
    search: "search",
    play: "run",
    stop: "cancel",
};

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
    name: IconName;
    size?: number;
    // Given an accessible name when it carries meaning; hidden when it is purely decorative.
    label?: string;
}

export function Icon({ name, size = 16, label, ...rest }: IconProps) {
    const accessible = label ?? ICON_LABELS[name];
    return (
        <svg
            className="icon"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            role="img"
            aria-label={accessible}
            {...rest}
            dangerouslySetInnerHTML={{ __html: PATHS[name] }}
        />
    );
}
