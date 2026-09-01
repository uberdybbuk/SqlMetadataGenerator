import { Link } from "react-router-dom";

import { api } from "../api";
import { useApi } from "../useApi";
import { Icon } from "../Icon";

export function ConnectionsPage() {
    const { data, error, loading } = useApi(() => api.connections(), []);

    if (loading) {
        return <div className="state">Bağlantılar yükleniyor…</div>;
    }
    if (error) {
        return <div className="error">{error}</div>;
    }
    if (!data?.length) {
        return (
            <div className="state">
                Tanımlı bağlantı yok. Repo kökündeki <code>connections.example.json</code> dosyasını{" "}
                <code>connections.json</code> olarak kopyalayın.
            </div>
        );
    }

    return (
        <>
            <h1>Bağlantılar</h1>
            <p className="subtitle">{data.length} sunucu tanımlı</p>
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
                                <> · <span style={{ color: "var(--danger)" }}>parola yok</span></>
                            )}
                        </div>
                        {c.description && <div className="meta">{c.description}</div>}
                    </Link>
                ))}
            </div>
        </>
    );
}
