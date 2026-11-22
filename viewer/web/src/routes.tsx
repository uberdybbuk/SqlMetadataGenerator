import { Route, Routes, type Location } from "react-router-dom";

import { ConnectionsPage } from "./pages/ConnectionsPage";
import { ConnectionFormPage } from "./pages/ConnectionFormPage";
import { ServerPage } from "./pages/ServerPage";
import { DatabasePage } from "./pages/DatabasePage";
import { TableListPage } from "./pages/TableListPage";
import { TableDetailPage } from "./pages/TableDetailPage";
import { QueryPage } from "./pages/QueryPage";
import { ObjectListPage, SchemaListPage } from "./pages/ObjectListPage";
import { ObjectDetailPage } from "./pages/ObjectDetailPage";
import { SettingsPage } from "./pages/SettingsPage";

// The pages, drawn for ONE tab. Every open tab renders this with its own location, so the hooks
// in a page (useParams, useMatch, useLocation) answer for that tab even while it is hidden.
//
// The URL is the location: every level is a real page, and every page can be bookmarked. The paths
// are relative to /app, where the layout that draws the tabs is mounted.
export function AppRoutes({ location }: { location: Partial<Location> & { pathname: string } }) {
    return (
        <Routes location={location}>
            <Route index element={<ConnectionsPage />} />
            <Route path="_connections/new" element={<ConnectionFormPage />} />
            <Route path="_connections/:alias/edit" element={<ConnectionFormPage />} />
            <Route path="_settings" element={<SettingsPage />} />
            <Route path=":alias" element={<ServerPage />} />
            {/* Scripting is nested rather than a sibling: a nested route keeps the
                parent mounted, so moving between the two modes does not throw away the
                script set you have built. The element is null because DatabasePage draws
                both modes itself; the route exists to claim the URL. */}
            <Route path=":alias/:db" element={<DatabasePage />}>
                <Route path="scripting" element={null} />
                <Route path="diagram" element={null} />
            </Route>
            {/* A bare /query only exists for a moment: the tab store numbers it and moves it to
                /query/<n>, which is what tells two query tabs on one database apart. */}
            <Route path=":alias/:db/query" element={<QueryPage />} />
            <Route path=":alias/:db/query/:queryNo" element={<QueryPage />} />
            <Route path=":alias/:db/tables" element={<TableListPage />} />
            <Route path=":alias/:db/tables/:schema" element={<TableListPage />} />
            <Route path=":alias/:db/tables/:schema/:name" element={<TableDetailPage />}>
                {/* The pivot is a MODE, in the URL like scripting and the diagram, so it
                    can be linked to and shared. The parent stays mounted. */}
                <Route path="pivot" element={null} />
            </Route>
            <Route path=":alias/:db/schemas" element={<SchemaListPage />} />
            <Route path=":alias/:db/:section" element={<ObjectListPage />} />
            <Route path=":alias/:db/:section/:schema/:name" element={<ObjectDetailPage />} />
        </Routes>
    );
}
