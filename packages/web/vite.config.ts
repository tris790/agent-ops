import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const BACKEND = process.env.BACKEND_URL ?? "http://127.0.0.1:4317";

// During dev, Vite serves the SPA and proxies API/SSE/WS traffic to the Bun backend.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5317,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true },
      "/events": { target: BACKEND, changeOrigin: true },
      "/lsp": { target: BACKEND, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
