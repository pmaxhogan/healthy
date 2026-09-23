import { fileURLToPath } from "node:url";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// A second, separate build for exactly one page: tool-sandbox.html (the
// sandboxed "Try a tool" JSON editor/viewer, shared/mcp-sandbox.ts's
// MCP_SANDBOX_PATH). It cannot be another entry in the main config's
// multi-entry build (vite.config.ts) because Rollup would still split shared
// chunks (Vue, CodeMirror, format helpers) out into their own /assets/*.js
// files -- and an ES module fetched via <script src> is always CORS-mode with
// credentials "same-origin", which this page's sandboxed, opaque origin
// (sandbox="allow-scripts", no allow-same-origin) turns into a genuinely
// cross-origin request sent with no cookie at all. ownerGate then answers
// with the login page instead of the script, and the module fails to
// execute with no console line and no failed network entry to explain why.
//
// viteSingleFile() inlines every generated script and stylesheet directly
// into the HTML, so the only request this page ever makes is the top-level
// navigation that loads the document itself -- which, unlike a subresource
// fetch, always carries cookies regardless of CORS. worker/app.ts still
// stamps a per-response CSP nonce onto the resulting inline <script> tag with
// HTMLRewriter, since a static build cannot bake in something that has to be
// fresh per response.
export default defineConfig({
  plugins: [vue(), viteSingleFile()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("shared", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    // The main build (vite.config.ts) runs first and owns emptying dist/;
    // this build only adds tool-sandbox.html alongside it.
    emptyOutDir: false,
    target: "es2022",
    modulePreload: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: fileURLToPath(new URL("tool-sandbox.html", import.meta.url)),
    },
  },
});
