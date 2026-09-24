import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { api, type ConnectionRequest, type ConnectionSummary } from "../api";
import { useApi } from "../useApi";
import { Icon } from "../Icon";

// The URL prefix of the connection screens. An alias can never start with '_', so no server
// named "connections" can ever be shadowed by these routes.
export const CONNECTIONS_ROUTE = "/app/_connections";

// Where the password comes from. "stored" writes it into connections.json in clear text;
// "env" leaves the file without one and reads the named environment variable at connect time.
type PasswordSource = "stored" | "env";

// The same rule the backend enforces, checked here too so the Save button can say why before
// a round trip does.
const ALIAS_RULE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// The environment variable the backend falls back to when none is named.
function defaultPasswordEnv(alias: string): string {
    return "SQLMETA_PW_" + alias.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

// /app/_connections/new and /app/_connections/<alias>/edit. The edit form needs the entry as it
// is now, and the list endpoint already carries every field the form shows.
export function ConnectionFormPage() {
    const { alias } = useParams();
    const editing = alias !== undefined;
    const { data, error, loading } = useApi(() => api.connections(), [], editing);

    if (!editing) {
        return <ConnectionForm existing={null} />;
    }
    if (loading) {
        return <div className="state">Loading connection…</div>;
    }
    if (error) {
        return <div className="error">{error}</div>;
    }

    const existing = data?.find((c) => c.alias.toLowerCase() === alias.toLowerCase());
    if (!existing) {
        return <div className="error">Connection not found: '{alias}'.</div>;
    }
    return <ConnectionForm existing={existing} />;
}

type TestState =
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "ok"; message: string }
    | { kind: "fail"; message: string };

function ConnectionForm({ existing }: { existing: ConnectionSummary | null }) {
    const navigate = useNavigate();

    const [alias, setAlias] = useState(existing?.alias ?? "");
    const [description, setDescription] = useState(existing?.description ?? "");
    const [server, setServer] = useState(existing?.server ?? "");
    const [auth, setAuth] = useState<"sql" | "integrated">(
        existing?.auth === "integrated" ? "integrated" : "sql",
    );
    const [user, setUser] = useState(existing?.user ?? "");
    // A new connection defaults to storing the password: that is what the screen is for. An
    // existing one opens on whatever it uses today, so saving it unchanged changes nothing.
    const [source, setSource] = useState<PasswordSource>(
        existing && !existing.passwordStored ? "env" : "stored",
    );
    const [password, setPassword] = useState("");
    // Only a name the file actually carries is shown; the computed default is the placeholder.
    const [passwordEnv, setPasswordEnv] = useState(
        existing && existing.passwordEnv !== defaultPasswordEnv(existing.alias) ? existing.passwordEnv : "",
    );
    const [encrypt, setEncrypt] = useState(existing?.encrypt ?? true);
    const [trust, setTrust] = useState(existing?.trustServerCertificate ?? true);

    const [test, setTest] = useState<TestState>({ kind: "idle" });
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);

    const hasStored = existing?.passwordStored ?? false;

    // The request as the backend reads it. The password field left blank on an entry that already
    // stores one means "keep it"; switching to the environment variable removes it from the file.
    function request(): ConnectionRequest {
        const sql = auth === "sql";
        let pw: string | undefined;
        if (sql && source === "stored") {
            pw = password === "" && hasStored ? undefined : password;
        } else if (sql && hasStored) {
            pw = "";
        }
        return {
            alias: alias.trim(),
            server: server.trim(),
            auth,
            user: sql ? user.trim() : undefined,
            password: pw,
            passwordEnv: sql && source === "env" ? passwordEnv.trim() || undefined : undefined,
            encrypt,
            trustServerCertificate: trust,
            description: description.trim() || undefined,
        };
    }

    // Why Save is not allowed yet, or null. Test only needs the server: an alias is not required
    // to find out whether the address answers.
    function problem(): string | null {
        if (!ALIAS_RULE.test(alias.trim())) {
            return "Alias: letters, digits, '-' and '_', starting with a letter or digit.";
        }
        if (!server.trim()) {
            return "Server is required.";
        }
        if (auth === "sql" && !user.trim()) {
            return "User is required for SQL Server authentication.";
        }
        if (auth === "sql" && source === "stored" && !password && !hasStored) {
            return "Enter a password, or read it from an environment variable.";
        }
        return null;
    }

    async function runTest() {
        setTest({ kind: "running" });
        try {
            const info = await api.testConnection(request());
            setTest({
                kind: "ok",
                message: `${info.edition} · ${info.productVersion} ${info.productLevel} · ${info.machineName}`,
            });
        } catch (err) {
            setTest({ kind: "fail", message: err instanceof Error ? err.message : String(err) });
        }
    }

    async function save(event: FormEvent) {
        event.preventDefault();
        if (problem()) {
            return;
        }
        setSaving(true);
        setSaveError(null);
        try {
            if (existing) {
                await api.updateConnection(existing.alias, request());
            } else {
                await api.addConnection(request());
            }
            navigate("/app");
        } catch (err) {
            setSaveError(err instanceof Error ? err.message : String(err));
            setSaving(false);
        }
    }

    async function remove() {
        if (!existing || !window.confirm(`Delete the connection '${existing.alias}'?`)) {
            return;
        }
        setSaving(true);
        setSaveError(null);
        try {
            await api.deleteConnection(existing.alias);
            navigate("/app");
        } catch (err) {
            setSaveError(err instanceof Error ? err.message : String(err));
            setSaving(false);
        }
    }

    const blocked = problem();

    return (
        <form className="conn-form" onSubmit={save}>
            <h1 className="with-icon">
                <Icon name="server" size={20} />
                {existing ? `Edit ${existing.alias}` : "New connection"}
            </h1>
            <p className="subtitle">Saved to connections.json; the change applies immediately.</p>

            <div className="field">
                <label htmlFor="cf-alias">Alias</label>
                <input
                    id="cf-alias"
                    className="mono"
                    value={alias}
                    onChange={(e) => setAlias(e.target.value)}
                    // The alias is part of every URL into this server; renaming it would break them.
                    disabled={existing !== null}
                    placeholder="prod-db"
                    autoFocus={!existing}
                    autoComplete="off"
                />
                <span className="hint">
                    {existing
                        ? "The alias is part of the URL and cannot be changed."
                        : "Letters, digits, '-' and '_'. Used in the URL."}
                </span>
            </div>

            <div className="field">
                <label htmlFor="cf-desc">Description</label>
                <input id="cf-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>

            <div className="field">
                <label htmlFor="cf-server">Server</label>
                <input
                    id="cf-server"
                    className="mono"
                    value={server}
                    onChange={(e) => setServer(e.target.value)}
                    placeholder="localhost,1433"
                    autoFocus={existing !== null}
                    autoComplete="off"
                />
            </div>

            <fieldset className="field">
                <legend>Authentication</legend>
                <div className="radios">
                    <label className="opt">
                        <input type="radio" checked={auth === "sql"} onChange={() => setAuth("sql")} />
                        SQL Server
                    </label>
                    <label className="opt">
                        <input type="radio" checked={auth === "integrated"} onChange={() => setAuth("integrated")} />
                        Windows
                    </label>
                </div>
            </fieldset>

            {auth === "sql" && (
                <>
                    <div className="field">
                        <label htmlFor="cf-user">User</label>
                        <input
                            id="cf-user"
                            className="mono"
                            value={user}
                            onChange={(e) => setUser(e.target.value)}
                            autoComplete="off"
                        />
                    </div>

                    <fieldset className="field">
                        <legend>Password</legend>
                        <div className="radios">
                            <label className="opt">
                                <input
                                    type="radio"
                                    checked={source === "stored"}
                                    onChange={() => setSource("stored")}
                                />
                                Save in connections.json
                            </label>
                            <label className="opt">
                                <input type="radio" checked={source === "env"} onChange={() => setSource("env")} />
                                Environment variable
                            </label>
                        </div>
                        {source === "stored" ? (
                            <>
                                <input
                                    type="password"
                                    aria-label="Password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    placeholder={hasStored ? "Unchanged" : ""}
                                    autoComplete="new-password"
                                />
                                <span className="hint">
                                    Stored in clear text. connections*.json is ignored by Git.
                                    {hasStored && " Leave blank to keep the current password."}
                                </span>
                            </>
                        ) : (
                            <>
                                <input
                                    className="mono"
                                    aria-label="Environment variable"
                                    value={passwordEnv}
                                    onChange={(e) => setPasswordEnv(e.target.value)}
                                    placeholder={defaultPasswordEnv(alias.trim() || "alias")}
                                    autoComplete="off"
                                />
                                <span className="hint">
                                    Read when connecting; set it before starting the API.
                                    {hasStored && " The stored password will be removed from the file."}
                                </span>
                            </>
                        )}
                    </fieldset>
                </>
            )}

            <fieldset className="field">
                <legend>Options</legend>
                <label className="opt">
                    <input type="checkbox" checked={encrypt} onChange={(e) => setEncrypt(e.target.checked)} />
                    Encrypt
                </label>
                <label className="opt">
                    <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
                    Trust server certificate
                </label>
            </fieldset>

            <div className="test-row">
                <button
                    type="button"
                    className="tool"
                    onClick={runTest}
                    disabled={!server.trim() || test.kind === "running"}
                >
                    <Icon name="play" size={14} />
                    {test.kind === "running" ? "Testing…" : "Test connection"}
                </button>
                {test.kind === "ok" && <span className="test-ok">✓ {test.message}</span>}
                {test.kind === "fail" && <span className="test-fail">✗ {test.message}</span>}
            </div>

            {saveError && <div className="error">{saveError}</div>}

            <div className="form-actions">
                {existing && (
                    <button type="button" className="tool danger" onClick={remove} disabled={saving}>
                        <Icon name="trash" size={14} />
                        Delete
                    </button>
                )}
                <span className="grow muted">{blocked}</span>
                <Link className="tool" to="/app">
                    Cancel
                </Link>
                <button type="submit" className="tool primary" disabled={saving || blocked !== null}>
                    {saving ? "Saving…" : "Save"}
                </button>
            </div>
        </form>
    );
}
