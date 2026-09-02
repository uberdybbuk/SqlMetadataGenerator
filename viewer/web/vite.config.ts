import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            // A single-origin illusion: the frontend writes "/api/..." in both modes, so CORS never comes up.
            "/api": {
                target: "http://localhost:5099",
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
