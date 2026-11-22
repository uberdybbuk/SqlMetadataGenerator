import type { IconName } from "../Icon";

// What a URL means as a tab: which tab it belongs to, and how that tab is labelled.
//
// The key is the tab's identity. Several URLs can share one key, because some of them are views
// of the same thing rather than different things: a table's pivot is that table's tab, the
// scripting and diagram modes are the database's tab, and a schema chip on the table list only
// filters the list it is already on. Opening one of those URLs moves the tab that has the key; it
// does not open a second one.
export interface TabRoute {
    key: string;
    title: string;
    icon?: IconName;
    // The server and database the tab is about, when it is about one. The tree follows these when
    // the tab becomes active, and the tab bar names the database when it differs from the active one.
    alias?: string;
    db?: string;
    // A bare /query URL is a request for a NEW query tab, not a tab of its own. The tab store
    // gives it a number and rewrites the URL to /query/<n>.
    newQuery?: boolean;
}

export const SECTION_LABELS: Record<string, string> = {
    tables: "Tables",
    views: "Views",
    procedures: "Procedures",
    functions: "Functions",
    triggers: "Triggers",
    synonyms: "Synonyms",
    sequences: "Sequences",
    types: "Types",
    schemas: "Schemas",
    scripting: "Scripting",
    diagram: "Diagram",
    query: "Query",
};

const SECTION_ICONS: Record<string, IconName> = {
    tables: "table",
    views: "view",
    procedures: "procedure",
    functions: "function",
    triggers: "trigger",
    synonyms: "synonym",
    sequences: "sequence",
    types: "type",
    schemas: "schema",
};

const enc = encodeURIComponent;

function decode(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

export function describeRoute(pathname: string): TabRoute {
    const parts = pathname.split("/").filter(Boolean).map(decode);
    if (parts[0] !== "app" || parts.length === 1) {
        return { key: "/app", title: "Connections", icon: "server" };
    }

    const [, alias, db, section, schema, name] = parts;

    if (alias === "_settings") {
        return { key: "/app/_settings", title: "Settings" };
    }
    if (alias === "_connections") {
        return db && db !== "new"
            ? { key: `/app/_connections/${enc(db)}/edit`, title: `Edit ${db}`, icon: "edit" }
            : { key: "/app/_connections/new", title: "New connection", icon: "plus" };
    }

    const serverBase = `/app/${enc(alias)}`;
    if (!db) {
        return { key: serverBase, title: alias, icon: "server", alias };
    }

    const dbBase = `${serverBase}/${enc(db)}`;
    const inDb = { alias, db };

    // The database page draws its overview, scripting and diagram modes itself.
    if (!section || section === "scripting" || section === "diagram") {
        return { key: dbBase, title: db, icon: "database", ...inDb };
    }

    if (section === "query") {
        if (!schema) {
            return { key: `${dbBase}/query`, title: "Query", ...inDb, newQuery: true };
        }
        return { key: `${dbBase}/query/${enc(schema)}`, title: `Query ${schema}`, icon: "play", ...inDb };
    }

    // The schema chips only filter the list, so every table list of a database is one tab.
    if (section === "tables" && !name) {
        return { key: `${dbBase}/tables`, title: "Tables", icon: "table", ...inDb };
    }

    if (!schema || !name) {
        return {
            key: `${dbBase}/${enc(section)}`,
            title: SECTION_LABELS[section] ?? section,
            icon: SECTION_ICONS[section],
            ...inDb,
        };
    }

    // A table's pivot is a mode of the table page, so anything past the name is the same tab.
    return {
        key: `${dbBase}/${enc(section)}/${enc(schema)}/${enc(name)}`,
        title: `${schema}.${name}`,
        icon: SECTION_ICONS[section],
        ...inDb,
    };
}
