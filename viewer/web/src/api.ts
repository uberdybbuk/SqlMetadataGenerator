// A mirror of the backend DTOs. The names match exactly because ASP.NET Core serialises camelCase.

export interface ConnectionSummary {
    alias: string;
    server: string;
    auth: string;
    user: string | null;
    description: string | null;
    passwordEnv: string;
    passwordSet: boolean;
}

export interface ServerInfo {
    productVersion: string;
    productLevel: string;
    edition: string;
    collation: string;
    machineName: string;
}

export interface DatabaseInfo {
    name: string;
    state: string;
    recoveryModel: string;
    compatibilityLevel: number;
    collation: string | null;
    createDate: string;
    dataMb: number;
    logMb: number;
    isBrowsable: boolean;
}

export interface TableStats {
    schema: string;
    name: string;
    rowCount: number;
    reservedKb: number;
    usedKb: number;
}

export interface SchemaInfo {
    name: string;
    owner: string;
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
    rows: unknown[][];
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

    server: (alias: string) =>
        get<{ server: ServerInfo; databases: DatabaseInfo[] }>(`/api/servers/${seg(alias)}`),

    database: (alias: string, db: string) =>
        get<DatabaseOverview>(`/api/servers/${seg(alias)}/databases/${seg(db)}`),

    // A statement the user typed. POST: a query does not belong in a URL, and a link should not be
    // able to run one on its own.
    query: (alias: string, db: string, sql: string, signal?: AbortSignal) =>
        post<QueryResult>(`/api/servers/${seg(alias)}/databases/${seg(db)}/query`, { sql }, signal),

    // The scripting picker's inventory: names only, one round trip. The kinds come back with it so
    // the panel does not carry its own copy of the generator's vocabulary.
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
