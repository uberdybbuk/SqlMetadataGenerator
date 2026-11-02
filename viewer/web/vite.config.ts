import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [react()],
    server: {
        port: 7750,
        // Fixed: the start script and bookmarks point here. A taken port is an error, not a reason
        // to move on unnoticed — the next port up, 7751, is the API's.
        strictPort: true,
        // A leading dot allows the domain and every subdomain: quick tunnels get a new name each run.
        allowedHosts: [".trycloudflare.com"],
        proxy: {
            // A single-origin illusion: the frontend writes "/api/..." in both modes, so CORS never comes up.
            "/api": {
                target: "http://localhost:7751",
                changeOrigin: true,
            },
        },
    },
    build: {
        // In production ASP.NET Core serves this folder as wwwroot.
        outDir: "../../src/SqlMetadataGenerator.Web/wwwroot",
        emptyOutDir: true,
    },
});
