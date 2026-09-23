// History-mode routing. The Worker serves index.html for any gated path it does
// not own itself, so a deep link and a reload both land here rather than on a
// 404.
//
// Views are lazily imported: the overview is the page the owner opens, and there
// is no reason for it to carry the MCP policy editor's code.

import { createRouter, createWebHistory } from "vue-router";

import type { RouteRecordRaw } from "vue-router";

/** Also the nav order in the header. */
export const NAV: { path: string; label: string }[] = [
  { path: "/", label: "Overview" },
  { path: "/health-systems", label: "Health systems" },
  { path: "/calendar", label: "Calendar" },
  { path: "/connectors", label: "MCP" },
  { path: "/alerts", label: "Alerts" },
  { path: "/mail", label: "Mail" },
  { path: "/runs", label: "Runs" },
  { path: "/settings", label: "Settings" },
];

const routes: RouteRecordRaw[] = [
  { path: "/", name: "overview", component: () => import("./views/OverviewView.vue") },
  {
    path: "/health-systems",
    name: "health_systems",
    component: () => import("./views/HealthSystemsView.vue"),
  },
  { path: "/calendar", name: "calendar", component: () => import("./views/CalendarView.vue") },
  // Not /mcp: worker/mcp/oauth-config.ts's MCP_API_ROUTE claims that exact path
  // for the MCP transport itself, ahead of this Hono/SPA app (see
  // worker/index.ts). An admin page at the same path always lost to it, so a
  // direct load or reload of /mcp 401'd with an empty body instead of ever
  // reaching this component. The route name stays "mcp"; only the path moved.
  { path: "/connectors", name: "mcp", component: () => import("./views/McpView.vue") },
  { path: "/alerts", name: "alerts", component: () => import("./views/AlertsView.vue") },
  { path: "/mail", name: "mail", component: () => import("./views/MailView.vue") },
  { path: "/runs", name: "runs", component: () => import("./views/RunsView.vue") },
  { path: "/settings", name: "settings", component: () => import("./views/SettingsView.vue") },
  // Anything else the SPA is handed is a stale bookmark; the overview is the
  // only sensible place to put someone who typed a path that no longer exists.
  { path: "/:pathMatch(.*)*", redirect: "/" },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});
