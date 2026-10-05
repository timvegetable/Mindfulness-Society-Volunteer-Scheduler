import { defineConfig } from "vite";

export default defineConfig({
  build: { outDir: "dist/client" },
  server: { proxy: { "/api": "http://127.0.0.1:8787", "/client-config": "http://127.0.0.1:8787" } },
});
