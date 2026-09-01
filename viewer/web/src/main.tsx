import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { Layout } from "./Layout";
import { ConnectionsPage } from "./pages/ConnectionsPage";
import { ServerPage } from "./pages/ServerPage";
import { DatabasePage } from "./pages/DatabasePage";
import { TableListPage } from "./pages/TableListPage";
import { TableDetailPage } from "./pages/TableDetailPage";
import "./styles.css";

// URL konumdur: her seviye gerçek bir sayfa, her sayfa bookmark'lanabilir.
createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <BrowserRouter>
            <Routes>
                <Route path="/" element={<Navigate to="/app" replace />} />
                <Route path="/app" element={<Layout />}>
                    <Route index element={<ConnectionsPage />} />
                    <Route path=":alias" element={<ServerPage />} />
                    <Route path=":alias/:db" element={<DatabasePage />} />
                    <Route path=":alias/:db/tables" element={<TableListPage />} />
                    <Route path=":alias/:db/tables/:schema" element={<TableListPage />} />
                    <Route path=":alias/:db/tables/:schema/:name" element={<TableDetailPage />} />
                </Route>
            </Routes>
        </BrowserRouter>
    </StrictMode>,
);
