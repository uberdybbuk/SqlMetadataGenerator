// Backend DTO'larının aynası. ASP.NET Core camelCase serileştirdiği için adlar birebir.

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
    truncated: boolean;
}

export interface PreviewResult {
    columns: PreviewColumn[];
    rows: (string | number | boolean | null)[][];
}

// Backend hataları RFC 7807 ProblemDetails olarak döner; "detail" alanı kullanıcıya
// gösterilecek asıl mesajdır (ör. SQL Server'ın kendi sözdizimi hatası).
export class ApiError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

async function get<T>(path: string): Promise<T> {
    const response = await fetch(path);
    if (!response.ok) {
        let detail = `${response.status} ${response.statusText}`;
        try {
            const problem = await response.json();
            detail = problem.detail ?? problem.title ?? detail;
        } catch {
            // Gövde JSON değilse durum satırıyla yetin.
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

    preview: (alias: string, db: string, schema: string, name: string, top = 20) =>
        get<PreviewResult>(
            `/api/servers/${seg(alias)}/databases/${seg(db)}/tables/${seg(schema)}/${seg(name)}/preview?top=${top}`,
        ),
};
