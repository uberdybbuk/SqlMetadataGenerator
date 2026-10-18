import { api } from "./api";

// Sharing a query with a colleague.
//
// The TEXT is kept on the server and the link carries only the id, so what lands in a chat
// window is short and says where it goes: /app/<alias>/<db>/query?q=<id>. Anyone reading the
// link sees which server and which database it opens before deciding to click it.
//
// Opening one never runs it. That is the same rule the query endpoint states — a link must not
// be able to make someone's machine run SQL — and it is why this is worth having at all.

export function shareUrl(alias: string, db: string, id: string): string {
    const path = `/app/${encodeURIComponent(alias)}/${encodeURIComponent(db)}/query?q=${encodeURIComponent(id)}`;
    return new URL(path, window.location.origin).toString();
}

// The callback QueryPane's Share button expects: saves the text and answers with the link.
export function shareLinkFor(alias: string, db: string) {
    return async (sql: string) => {
        const saved = await api.shareQuery(alias, db, sql);
        // Built from what the server stored rather than from the arguments, so the link always
        // describes the record that actually exists.
        return shareUrl(saved.alias, saved.database, saved.id);
    };
}
