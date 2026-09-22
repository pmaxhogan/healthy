// DTOs shared between the Worker's /api routes and the Vue SPA. This module is
// the only bridge between the two: worker/** must not import src/**, and src/**
// must not import worker/** (enforced by eslint). Anything both need lives here.
//
// It must stay runtime-free: types and plain constants only, no Node APIs, no
// Worker APIs, no DOM.

/** Wire shape of every error response the API produces. */
export interface ApiError {
  error: string;
}

/** GET /health. The one public route, so it says nothing else. */
export interface HealthResponse {
  ok: true;
}

// TODO(wave2): the rest of the DTOs land here next to the routes that produce
// them, so a type never arrives before its producer:
//   ConnectionStatus  'connected' | 'needs_reauth' | 'error' | 'disconnected'
//   CalendarEventState 'active' | 'ghost'
//   HEALTHY_EVENT_MARKER -- the extendedProperties.private key ("healthy")
//     that every event this project writes carries, and that the sync requires
//     before it will read or modify any calendar entry.
//   ProviderSummary, ConnectionSummary, OverviewResponse, SettingsPayload,
//   GoogleStatus, McpGrant, McpAuditEntry, RunLogEntry, BrandSearchResult,
//   AlertSummary.
