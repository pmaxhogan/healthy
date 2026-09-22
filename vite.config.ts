import { fileURLToPath } from "node:url";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// The SPA build. Output goes to dist/, which wrangler.jsonc publishes as the
// ASSETS binding -- so `vite build` is a prerequisite of `wrangler deploy`, and
// `npm run check` runs it last for exactly that reason.
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("shared", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
    emptyOutDir: true,
  },
  server: {
    // `npm run dev` serves the SPA from Vite and forwards everything the Worker
    // owns to `npm run dev:worker`, so the auth gates and the OAuth callbacks
    // behave the same locally as in production.
    proxy: {
      "/api": "http://localhost:8787",
      "/auth": "http://localhost:8787",
    },
  },
});
