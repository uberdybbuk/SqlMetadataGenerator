import { Link, Outlet, useLocation } from "react-router-dom";

// Breadcrumb doğrudan URL'den türetilir — ayrı bir gezinme state'i yok.
// Böylece adres çubuğuna elle yazılan bir yol da tutarlı görünür.
function Breadcrumbs() {
    const { pathname } = useLocation();
    const parts = pathname.split("/").filter(Boolean);

    const crumbs = parts.map((part, index) => ({
        label: decodeURIComponent(part),
        href: "/" + parts.slice(0, index + 1).join("/"),
        last: index === parts.length - 1,
    }));

    return (
        <nav className="crumbs">
            {crumbs.map((crumb) => (
                <span key={crumb.href}>
                    {crumb.last ? (
                        <span className="current">{crumb.label}</span>
                    ) : (
                        <Link to={crumb.href}>{crumb.label}</Link>
                    )}
                    {!crumb.last && <span className="sep"> / </span>}
                </span>
            ))}
        </nav>
    );
}

export function Layout() {
    return (
        <div className="shell">
            <Breadcrumbs />
            <Outlet />
        </div>
    );
}
