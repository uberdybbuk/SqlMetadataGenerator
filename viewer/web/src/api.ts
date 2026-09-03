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

export interface TableDetail {
    schema: string;
    name: string;
    columns: ColumnSummary[];
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

function get<T>(path: string): Promise<T> {
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

async function fetchJson<T>(path: string): Promise<T> {
    const response = await fetch(path);
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

const seg = (value: string) => encodeURIComponent(value);

export const api = {
    connections: () => get<ConnectionSummary[]>("/api/servers"),

    server: (alias: string) =>
        get<{ server: ServerInfo; databases: DatabaseInfo[] }>(`/api/servers/${seg(alias)}`),

    database: (alias: string, db: string) =>
        get<DatabaseOverview>(`/api/servers/${seg(alias)}/databases/${seg(db)}`),

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

    preview: (alias: string, db: string, schema: string, name: string, top = 20) =>
        get<PreviewResult>(
            `/api/servers/${seg(alias)}/databases/${seg(db)}/tables/${seg(schema)}/${seg(name)}/preview?top=${top}`,
        ),
};
