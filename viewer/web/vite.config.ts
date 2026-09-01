import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            // Tek origin görüntüsü: frontend her iki modda da "/api/..." yazar, CORS derdi olmaz.
            "/api": {
                target: "http://localhost:5099",
                changeOrigin: true,
            },
        },
    },
    build: {
        // Production'da ASP.NET Core bu klasörü wwwroot olarak sunar.
        outDir: "../../src/SqlMetadataGenerator.Web/wwwroot",
        emptyOutDir: true,
    },
});
