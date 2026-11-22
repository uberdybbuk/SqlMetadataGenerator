import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { Layout } from "./Layout";
import { TabsProvider } from "./tabs/TabStore";
import { installTheme } from "./theme";
import "./styles.css";

installTheme();

// Everything under /app is drawn by the layout, which opens each location in a tab. The page
// routes themselves are in routes.tsx, rendered once per open tab.
createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <BrowserRouter>
            <Routes>
                <Route path="/" element={<Navigate to="/app" replace />} />
                <Route
                    path="/app/*"
                    element={
                        <TabsProvider>
                            <Layout />
                        </TabsProvider>
                    }
                />
            </Routes>
        </BrowserRouter>
    </StrictMode>,
);
