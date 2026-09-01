import { Link, useParams } from "react-router-dom";

import { api } from "../api";
import { useApi } from "../useApi";
import { formatDate, formatMb } from "../format";

export function ServerPage() {
    const { alias = "" } = useParams();
    const { data, error, loading } = useApi(() => api.server(alias), [alias]);

    if (loading) {
        return <div className="state">Sunucu okunuyor…</div>;
    }
    if (error) {
        return <div className="error">{error}</div>;
    }
    if (!data) {
        return null;
    }

    const { server, databases } = data;
    const totalMb = databases.reduce((sum, db) => sum + db.dataMb, 0);
    // En büyük veritabanı en üstte: ilgilenilen genelde o.
    const sorted = [...databases].sort((a, b) => b.dataMb - a.dataMb);

    return (
        <>
            <h1>{alias}</h1>
            <p className="subtitle">
                SQL Server {server.productVersion} {server.productLevel} · {server.edition} ·{" "}
                {server.collation} · {server.machineName}
            </p>

            <div className="badges">
                <span className="badge">
                    <b>{databases.length}</b> veritabanı
                </span>
                <span className="badge">
                    toplam <b>{formatMb(totalMb)}</b> veri
                </span>
            </div>

            <div className="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>Veritabanı</th>
                            <th className="num">Veri</th>
                            <th className="num">Log</th>
                            <th>Durum</th>
                            <th>Kurtarma</th>
                            <th>Collation</th>
                            <th>Oluşturma</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sorted.map((db) => (
                            <tr key={db.name}>
                                <td>
                                    {db.isBrowsable ? (
                                        <Link
                                            className="mono"
                                            to={`/app/${encodeURIComponent(alias)}/${encodeURIComponent(db.name)}`}
                                        >
                                            {db.name}
                                        </Link>
                                    ) : (
                                        <span className="mono muted">{db.name}</span>
                                    )}
                                </td>
                                <td className="num">{formatMb(db.dataMb)}</td>
                                <td className="num">{formatMb(db.logMb)}</td>
                                <td>
                                    {db.state === "ONLINE" ? (
                                        <span className="muted">online</span>
                                    ) : (
                                        <span className="pill">{db.state.toLowerCase()}</span>
                                    )}
                                </td>
                                <td className="muted">{db.recoveryModel.toLowerCase()}</td>
                                <td className="muted mono" style={{ fontSize: 12 }}>
                                    {db.collation ?? "—"}
                                </td>
                                <td className="muted mono" style={{ fontSize: 12 }}>
                                    {formatDate(db.createDate)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <p className="subtitle" style={{ marginTop: 12 }}>
                Boyutlar <code>sys.master_files</code>'tan gelir: ayrılmış dosya boyutudur,
                kullanılan alan değil.
            </p>
        </>
    );
}
