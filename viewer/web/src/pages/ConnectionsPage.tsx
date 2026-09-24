import { Link } from "react-router-dom";

import { api } from "../api";
import { useApi } from "../useApi";
import { plural } from "../format";
import { Icon } from "../Icon";
import { APP_NAME } from "../Layout";
import { CONNECTIONS_ROUTE } from "./ConnectionFormPage";

export function ConnectionsPage() {
    const { data, error, loading } = useApi(() => api.connections(), []);

    if (loading) {
        return <div className="state">Loading connections…</div>;
    }
    if (error) {
        return <div className="error">{error}</div>;
    }

    const connections = data ?? [];

    return (
        <>
            <h1>{APP_NAME}</h1>
            <p className="subtitle">
                {connections.length
                    ? `${connections.length} ${plural(connections.length, "server")} configured`
                    : "No connections yet. Add one to start exploring."}
            </p>
            <div className="cards">
                {connections.map((c) => (
                    // The edit button sits beside the card link, not inside it: a link inside a
                    // link is invalid HTML, and the click would open the server as well.
                    <div key={c.alias} className="card-wrap">
                        <Link className="card" to={`/app/${encodeURIComponent(c.alias)}`}>
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
                        <Link
                            className="card-edit"
                            to={`${CONNECTIONS_ROUTE}/${encodeURIComponent(c.alias)}/edit`}
                            title={`Edit ${c.alias}`}
                        >
                            <Icon name="edit" size={15} label={`Edit ${c.alias}`} />
                        </Link>
                    </div>
                ))}
                <Link className="card card-add" to={`${CONNECTIONS_ROUTE}/new`}>
                    <Icon name="plus" size={18} />
                    New connection
                </Link>
            </div>
        </>
    );
}
