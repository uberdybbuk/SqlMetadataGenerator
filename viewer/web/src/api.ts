// A mirror of the backend DTOs. The names match exactly because ASP.NET Core serialises camelCase.

// Which engine is behind a connection. Everything browsing-related works on both; script
// generation is SQL Server only and the server answers 501 for it.
export type Provider = "sqlserver" | "postgres";

export interface ConnectionSummary {
    alias: string;
    server: string;
    provider: Provider;
    auth: string;
    user: string | null;
    description: string | null;
    encrypt: boolean;
    trustServerCertificate: boolean;
    passwordEnv: string;
    // A password is written in connections.json. The password itself never comes back.
    passwordStored: boolean;
    // Stored, or found in the environment variable: the connection has something to log in with.
    passwordSet: boolean;
}

// The connection form as it is sent. password: undefined keeps what is stored, "" removes it
// (the environment variable takes over again), anything else replaces it.
export interface ConnectionRequest {
    alias: string;
    server: string;
    provider: Provider;
    auth: "sql" | "integrated";
    user?: string;
    password?: string;
    passwordEnv?: string;
    encrypt: boolean;
    trustServerCertificate: boolean;
    description?: string;
}

export interface ServerInfo {
    // "SQL Server" or "PostgreSQL" — what the server calls itself, rather than a guess from the
    // connection entry.
    product: string;
    productVersion: string;
    productLevel: string;
    edition: string;
    collation: string;
    machineName: string;
}

// Null on the fields PostgreSQL has no counterpart for: there is no recovery model, no
// compatibility level, no separate log file, and no creation timestamp in the catalog.
export interface DatabaseInfo {
    name: string;
    state: string;
    recoveryModel: string | null;
    compatibilityLevel: number | null;
    collation: string | null;
    createDate: string | null;
    dataMb: number;
    logMb: number | null;
    isBrowsable: boolean;
}

export interface TableStats {
    schema: string;
    name: string;
    // Null means unknown: PostgreSQL has no estimate for a table that was never analysed.
    rowCount: number | null;
    reservedKb: number;
    usedKb: number;
}

export interface SchemaInfo {
    name: string;
    owner: string;
}

// The relationship graph. Links are INFERRED from column names, never from foreign keys, and
// every one carries how good a guess it is — see RelationshipInference. The whole graph arrives
// in one call so seeding, expanding and the confidence toggles never wait on the server.
export interface GraphColumn {
    name: string;
    typeName: string;
    isNullable: boolean;
    isPrimaryKey: boolean;
}

export interface GraphTable {
    schema: string;
    name: string;
    columns: GraphColumn[];
}

export type LinkConfidence = "high" | "medium" | "low";

export interface GraphLink {
    fromSchema: string;
    fromName: string;
    fromColumn: string;
    toSchema: string;
    toName: string;
    toColumn: string;
    confidence: LinkConfidence;
    // Which rule produced it, so an edge can explain itself rather than just appearing.
    rule: string;
    self: boolean;
}

// A column that looks like a reference and resolves to nothing. "why" separates a missing table
// from a type that cannot be joined — different problems with different fixes.
export interface GraphDangling {
    schema: string;
    name: string;
    column: string;
    why: "nosuchtable" | "ambiguous" | "typemismatch";
}

export interface DatabaseGraph {
    tables: GraphTable[];
    links: GraphLink[];
    dangling: GraphDangling[];
}

// The scripting picker's inventory. Kinds arrive with the objects so the panel's section order
// and its section titles come from the generator rather than from a second list kept in sync here.
export interface ScriptableInventory {
    kinds: { kind: string; title: string }[];
    objects: { kind: string; schema: string; name: string }[];
}

// What to script, and how to format it. The formatting fields are optional: leaving one out means
// the generator's default, which is what the per-table script tab already shows.
export interface ScriptRequest {
    objects: { kind: string; schema: string; name: string }[];
    // The tables whose ROWS were asked for, each with its own optional WHERE. Independent of
    // objects: a table can be in one, the other, or both.
    data: { schema: string; name: string; where?: string }[];
    upperCaseKeywords?: boolean;
    emitSetOptions?: boolean;
    groupColumns?: boolean;
}

export interface ScriptResult {
    sql: string;
    scripted: number;
    // Asked for, but gone from the catalog since the inventory was read.
    missing: string[];
    // Non-empty when the chosen tables reference each other in a cycle: no insert order satisfies
    // them, so the script brackets the load with NOCHECK/CHECK.
    cycleTables: string[];
}

// One row of an object list. The dashboard counters and this list share a catalog query, so a
// badge and the page it opens always agree.
export interface ObjectSummary {
    schema: string;
    name: string;
    typeDesc: string;
    parent: string | null;
    createDate: string;
    modifyDate: string;
}

// One object's DDL. generated=false means the text is what the server stores; true means the
// Scripting layer composed it, because the catalog holds the parts rather than a statement.
export interface ObjectDetail {
    schema: string;
    name: string;
    typeDesc: string;
    definition: string;
    generated: boolean;
    createDate: string;
    modifyDate: string;
}

export interface QueryColumn {
    name: string;
    typeName: string;
}

export interface QueryResult {
    columns: QueryColumn[];
    // The same shape a preview returns: the server formats every value before it is serialised.
    rows: (string | number | boolean | null)[][];
    sql: string;
    elapsedMs: number;
    messages: string[];
    // True when the reader stopped at the row cap; there were more rows to read.
    capped: boolean;
}

export interface DatabaseOverview {
    database: string;
    counts: Record<string, number>;
    schemas: SchemaInfo[];
}

export interface ColumnSummary {
    name: string;
    columnId: number;
    typeName: string;
    maxLength: number;
    precision: number;
    scale: number;
    isNullable: boolean;
    isIdentity: boolean;
    isComputed: boolean;
    defaultDefinition: string | null;
    primaryKeyOrdinal: number | null;
}

export interface IndexColumn {
    name: string;
    descending: boolean;
}

export interface IndexSummary {
    name: string;
    typeDesc: string;
    isUnique: boolean;
    isPrimaryKey: boolean;
    isUniqueConstraint: boolean;
    filter: string | null;
    keyColumns: IndexColumn[];
    includedColumns: string[];
}

export interface TableDetail {
    schema: string;
    name: string;
    columns: ColumnSummary[];
    indexes: IndexSummary[];
    // SQL Server records no "created by" anywhere; owner is the closest the catalog gets.
    owner: string | null;
    createDate: string | null;
    modifyDate: string | null;
    // The columns an INSERT for this table can name, quoted as the scripter quotes them. Computed
    // and rowversion columns are absent: the server assigns those, so naming them fails.
    insertableColumns: string[];
}

export interface PreviewColumn {
    name: string;
    typeName: string;
    // True when the value really was cut in this preview.
    truncated: boolean;
    // The full column metadata arrives with the result; the header card waits on no
    // separate request.
    column: ColumnSummary;
}

export interface PreviewResult {
    columns: PreviewColumn[];
    rows: (string | number | boolean | null)[][];
    // The query that produced the preview; shown to the user.
    sql: string;
    // The round-trip time between the application and the database.
    elapsedMs: number;
    // The informational messages the server returned (PRINT, warnings).
    messages: string[];
}

// The pivot. The spec travels as a STRUCTURE, never as SQL: the server looks every column up in
// the table's own shape and composes the GROUP BY itself, so nothing here is pasted into a
// statement as a name.
export type PivotGrain = "none" | "year" | "quarter" | "month" | "day";
export type PivotAgg = "count" | "countDistinct" | "sum" | "avg" | "min" | "max";

export interface PivotRowField {
    column: string;
    grain?: PivotGrain;
}

export interface PivotValueField {
    agg: PivotAgg;
    column?: string;
}

export interface PivotSpec {
    rows: PivotRowField[];
    values: PivotValueField[];
    where?: string;
    totals?: boolean;
}

export interface PivotResult {
    // The statement the server composed and ran. Shown on screen: a pivot you cannot read is a
    // black box over your own data.
    sql: string;
    rowFieldCount: number;
    measureCount: number;
    columns: QueryColumn[];
    rows: (string | number | boolean | null)[][];
    elapsedMs: number;
    capped: boolean;
}

// A query someone kept so the link could be sent to a colleague. The text lives on the server;
// the link only carries the id, which is why it stays short enough to paste into a chat.
export interface SharedQuery {
    id: string;
    alias: string;
    database: string;
    sql: string;
    title: string | null;
    createdUtc: string;
}

// Backend errors come back as RFC 7807 ProblemDetails; the "detail" field carries the
// message meant for the user (e.g. SQL Server's own syntax error).
export class ApiError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

// React StrictMode mounts every component twice in development, so a page that fires one request
// ends up sending it twice — a pointless second round trip to the database on every click. A path
// that is already in flight shares the running promise instead of opening a new request.
// Only in-flight ones: the entry is dropped the moment it settles, so nothing is served from a
// cache and coming back to a page always asks the server again.
const inFlight = new Map<string, Promise<unknown>>();

function get<T>(path: string, signal?: AbortSignal): Promise<T> {
    // A cancellable request is never shared: aborting one caller would abort the other, and the
    // sharing exists to save a duplicate round trip, not to tie two lifetimes together.
    if (signal) {
        return fetchJson<T>(path, signal);
    }
    const running = inFlight.get(path) as Promise<T> | undefined;
    if (running) {
        return running;
    }
    const request = fetchJson<T>(path).finally(() => {
        inFlight.delete(path);
    });
    inFlight.set(path, request);
    return request;
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return fetchJson<T>(path, signal, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

// PUT and DELETE answer 204 with no body; there is nothing to parse.
async function send(method: "PUT" | "DELETE", path: string, body?: unknown): Promise<void> {
    await fetchJson<void>(path, undefined, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

async function fetchJson<T>(path: string, signal?: AbortSignal, init?: RequestInit): Promise<T> {
    const response = await fetch(path, { ...init, signal });
    if (!response.ok) {
        let detail = `${response.status} ${response.statusText}`;
        try {
            const problem = await response.json();
            detail = problem.detail ?? problem.title ?? detail;
        } catch {
            // When the body is not JSON, settle for the status line.
        }
        throw new ApiError(detail, response.status);
    }
    if (response.status === 204) {
        return undefined as T;
    }
    return (await response.json()) as T;
}

// The same error reading as fetchJson, for a response whose body is a file rather than JSON.
async function problemText(response: Response): Promise<string> {
    try {
        const problem = await response.json();
        return problem.detail ?? problem.title ?? `${response.status} ${response.statusText}`;
    } catch {
        return `${response.status} ${response.statusText}`;
    }
}

const seg = (value: string) => encodeURIComponent(value);

export const api = {
    connections: () => get<ConnectionSummary[]>("/api/servers"),

    addConnection: (body: ConnectionRequest) => post<{ alias: string }>("/api/servers", body),

    updateConnection: (alias: string, body: ConnectionRequest) =>
        send("PUT", `/api/servers/${seg(alias)}`, body),

    deleteConnection: (alias: string) => send("DELETE", `/api/servers/${seg(alias)}`),

    // Tries the form as it stands, saved or not; answers with the server's version.
    testConnection: (body: ConnectionRequest, signal?: AbortSignal) =>
        post<ServerInfo>("/api/servers/test", body, signal),

    server: (alias: string) =>
        get<{ server: ServerInfo; databases: DatabaseInfo[] }>(`/api/servers/${seg(alias)}`),

    database: (alias: string, db: string) =>
        get<DatabaseOverview>(`/api/servers/${seg(alias)}/databases/${seg(db)}`),

    // A statement the user typed. POST: a query does not belong in a URL, and a link should not be
    // able to run one on its own.
    query: (alias: string, db: string, sql: string, signal?: AbortSignal) =>
        post<QueryResult>(`/api/servers/${seg(alias)}/databases/${seg(db)}/query`, { sql }, signal),

    pivot: (alias: string, db: string, schema: string, name: string, spec: PivotSpec, signal?: AbortSignal) =>
        post<PivotResult>(
            `/api/servers/${seg(alias)}/databases/${seg(db)}/tables/${seg(schema)}/${seg(name)}/pivot`,
            spec,
            signal,
        ),

    // Keeps a query server-side and answers with its id. Validated there with the same guard the
    // runner uses, so a link can never carry something that only fails when the colleague runs it.
    shareQuery: (alias: string, db: string, sql: string, title?: string) =>
        post<SharedQuery>("/api/shares", { alias, database: db, sql, title }),

    sharedQuery: (id: string) => get<SharedQuery>(`/api/shares/${seg(id)}`),

    // The scripting picker's inventory: names only, one round trip. The kinds come back with it so
    // the panel does not carry its own copy of the generator's vocabulary.
    graph: (alias: string, db: string) =>
        get<DatabaseGraph>(`/api/servers/${seg(alias)}/databases/${seg(db)}/graph`),

    scriptable: (alias: string, db: string) =>
        get<ScriptableInventory>(`/api/servers/${seg(alias)}/databases/${seg(db)}/scriptable`),

    // Scripts the chosen objects into one statement, sections in dependency order.
    script: (alias: string, db: string, body: ScriptRequest, signal?: AbortSignal) =>
        post<ScriptResult>(`/api/servers/${seg(alias)}/databases/${seg(db)}/script`, body, signal),

    // The same bundle as an archive, in the generator's folder layout. The FORMAT is the server's
    // call (7-Zip where the host has it, zip otherwise), so the headers come back with the bytes —
    // the caller needs Content-Disposition to name the download correctly.
    scriptFiles: async (
        alias: string,
        db: string,
        body: ScriptRequest,
    ): Promise<{ blob: Blob; headers: Headers }> => {
        const response = await fetch(`/api/servers/${seg(alias)}/databases/${seg(db)}/script/files`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            throw new Error(await problemText(response));
        }
        return { blob: await response.blob(), headers: response.headers };
    },

    // "Validate & count": checks the WHERE syntactically and returns how many rows match. The
    // scripting inspector uses it to turn an estimate into a fact before anyone scripts the table.
    countRows: (alias: string, db: string, schema: string, name: string, where: string, signal?: AbortSignal) =>
        get<{ rows: number; where: string | null }>(
            `/api/servers/${seg(alias)}/databases/${seg(db)}/tables/${seg(schema)}/${seg(name)}/count`
                + (where ? `?where=${encodeURIComponent(where)}` : ""),
            signal,
        ),

    objects: (alias: string, db: string, kind: string) =>
        get<ObjectSummary[]>(
            `/api/servers/${seg(alias)}/databases/${seg(db)}/objects/${seg(kind)}`,
        ),

    // The CREATE script for a table, from the same Scripting layer the generator writes files with.
    tableScript: (alias: string, db: string, schema: string, name: string) =>
        get<{ sql: string }>(
            `/api/servers/${seg(alias)}/databases/${seg(db)}/tables/${seg(schema)}/${seg(name)}/script`,
        ),

    objectDetail: (alias: string, db: string, kind: string, schema: string, name: string) =>
        get<ObjectDetail>(
            `/api/servers/${seg(alias)}/databases/${seg(db)}/objects/${seg(kind)}/${seg(schema)}/${seg(name)}`,
        ),

    tables: (alias: string, db: string) =>
        get<TableStats[]>(`/api/servers/${seg(alias)}/databases/${seg(db)}/tables`),

    table: (alias: string, db: string, schema: string, name: string) =>
        get<TableDetail>(
            `/api/servers/${seg(alias)}/databases/${seg(db)}/tables/${seg(schema)}/${seg(name)}`,
        ),

    // The query text alone, so the editor does not have to wait for the rows.
    previewSql: (alias: string, db: string, schema: string, name: string, top = 20) =>
        get<{ sql: string }>(
            `/api/servers/${seg(alias)}/databases/${seg(db)}/tables/${seg(schema)}/${seg(name)}/sql?top=${top}`,
        ),

    preview: (alias: string, db: string, schema: string, name: string, top = 20, signal?: AbortSignal) =>
        get<PreviewResult>(
            `/api/servers/${seg(alias)}/databases/${seg(db)}/tables/${seg(schema)}/${seg(name)}/preview?top=${top}`,
            signal,
        ),
};
