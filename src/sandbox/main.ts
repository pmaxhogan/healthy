// Entry point for tool-sandbox.html -- see shared/mcp-sandbox.ts and SandboxApp.vue
// for what this page is and why it is separate from the main SPA.
//
// Built by a second, separate Vite config (vite.sandbox.config.ts) that inlines
// this script and its CSS straight into the HTML with no separate /assets/*
// files. That is not a bundling preference: an ES module fetched via `<script
// src>` is always CORS-mode with credentials "same-origin", and this page's
// sandboxed, opaque origin (`sandbox="allow-scripts"`, no `allow-same-origin` --
// see McpToolTester.vue) makes every such fetch cross-origin, so it is sent with
// no cookie at all. `ownerGate` then answers with the login page instead of the
// script, which fails to execute with no console line and no failed network
// request to explain why -- the one request this page's own navigation makes
// (loading the HTML document itself) is not subject to this at all, since a
// top-level frame navigation always carries credentials regardless of CORS, so
// the document loads and everything referenced *inside* it looks identical to
// a normal deploy until you check whether the script ever actually ran. Found
// only by instrumenting `window.parent.postMessage` from the embedding page and
// watching for silence.
import { createApp } from "vue";

import "../style.css";

import SandboxApp from "./SandboxApp.vue";

createApp(SandboxApp).mount("#sandbox");
