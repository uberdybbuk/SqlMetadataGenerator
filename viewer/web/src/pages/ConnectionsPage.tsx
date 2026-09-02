import { Link } from "react-router-dom";

import { api } from "../api";
import { useApi } from "../useApi";
import { plural } from "../format";
import { Icon } from "../Icon";

export function ConnectionsPage() {
    const { data, error, loading } = useApi(() => api.connections(), []);

    if (loading) {
        return <div className="state">Loading connections…</div>;
    }
    if (error) {
        return <div className="error">{error}</div>;
    }
    if (!data?.length) {
        return (
            <div className="state">
                No connections defined. Copy <code>connections.example.json</code> in the repository
                root to <code>connections.json</code>.
            </div>
        );
    }

    return (
        <>
            <h1>Connections</h1>
            <p className="subtitle">
                {data.length} {plural(data.length, "server")} configured
            </p>
            <div className="cards">
                {data.map((c) => (
                    <Link key={c.alias} className="card" to={`/app/${encodeURIComponent(c.alias)}`}>
                        <div className="title">
                            <Icon name="server" size={18} />
                            {c.alias}
                        </div>
                        <div className="meta">{c.server}</div>
                        <div className="meta">
                            {c.auth === "integrated" ? "windows auth" : c.user}
                            {!c.passwordSet && c.auth !== "integrated" && (
                                <> · <span style={{ color: "var(--danger)" }}>no password</span></>
                            )}
                        </div>
                        {c.description && <div className="meta">{c.description}</div>}
                    </Link>
                ))}
            </div>
        </>
    );
}
