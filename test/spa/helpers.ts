// Shared scaffolding for the SPA tests.
//
// Everything here is synthetic. No real health system, practitioner, account or
// timezone appears in this repository's tests -- "Example Health" and friends are
// invented, and the fixture dates are fixed so relative-time assertions cannot
// drift.

import { createMemoryHistory, createRouter } from "vue-router";

import { configureClient } from "../../src/api/client.ts";

import type {
  AlertDto,
  BrandDto,
  ConnectionDto,
  MailInboxEntryDto,
  MailSettingsDto,
  OverviewDto,
  PortalAccountStatusDto,
  HealthSystemDto,
  RunDto,
  SettingsDto,
} from "@shared/types.ts";
import type { Component } from "vue";
import type { Router } from "vue-router";

/** Fixed "now" for the fixtures below, so relative times are deterministic. */
export const NOW = Date.parse("2026-09-21T12:00:00.000Z");

export interface FakeResponseInit {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Sends the body as text/html instead of JSON -- what the login wall returns. */
  html?: string;
}

/** A Response good enough for the client, without pulling in a server. */
export function fakeResponse(init: FakeResponseInit = {}): Response {
  const status = init.status ?? 200;
  const headers = new Headers(init.headers);
  if (init.html !== undefined) {
    headers.set("content-type", "text/html");
    return new Response(init.html, { status, headers });
  }
  if (init.body === undefined) return new Response(null, { status: 204, headers });
  headers.set("content-type", "application/json");
  return Response.json(init.body, { status, headers });
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

export interface FakeFetch {
  calls: RecordedCall[];
  fetch: typeof globalThis.fetch;
}

/**
 * Installs a fetch that answers from `routes`, keyed by the path it is asked for.
 *
 * A key may be an exact path or a prefix ending in `*`. Anything unmatched
 * answers 404, which is how a test notices a request it did not expect.
 */
export function installFakeApi(routes: Record<string, () => Response>): FakeFetch {
  const calls: RecordedCall[] = [];
  const table = new Map(Object.entries(routes));

  function respond(url: string): Response {
    const exact = table.get(url.split("?", 1)[0] ?? url);
    if (exact) return exact();
    for (const [pattern, make] of table) {
      if (pattern.endsWith("*") && url.startsWith(pattern.slice(0, -1))) return make();
    }
    return fakeResponse({ status: 404, body: { error: "not_found" } });
  }

  // Not `async`: there is nothing to await, and the lint rules that police async
  // functions would each want the other's fix.
  const fetchImpl: typeof globalThis.fetch = (input, init) => {
    const url = urlOf(input);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase(), headers, body });
    return Promise.resolve(respond(url));
  };

  const recorder: FakeFetch = { calls, fetch: fetchImpl };
  configureClient({
    fetch: fetchImpl,
    navigate: () => {
      // Tests that care about navigation install a recorder of their own.
    },
  });
  return recorder;
}

/** The URL a fetch was asked for, whatever shape the first argument took. */
export function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** A router with the routes the layout links to, on an in-memory history. */
export async function testRouter(initial = "/"): Promise<Router> {
  const blank: Component = { template: "<div />" };
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: blank },
      { path: "/health-systems", component: blank },
      { path: "/calendar", component: blank },
      { path: "/connectors", component: blank },
      { path: "/alerts", component: blank },
      { path: "/mail", component: blank },
      { path: "/runs", component: blank },
      { path: "/settings", component: blank },
    ],
  });
  await router.push(initial);
  await router.isReady();
  return router;
}

export function connection(overrides: Partial<ConnectionDto> = {}): ConnectionDto {
  return {
    id: "conn-1",
    healthSystemId: "prov-1",
    status: "connected",
    accessExpiresAt: "2026-09-21T12:45:00.000Z",
    hasRefreshToken: true,
    scope: "patient/*.read",
    lastRefreshAt: "2026-09-21T11:40:00.000Z",
    lastSyncAt: "2026-09-21T11:07:00.000Z",
    lastFullRefreshAt: "2026-09-21T06:23:00.000Z",
    lastErrorCode: null,
    needsReauthSince: null,
    refreshFailures: 0,
    reconnectPath: "/reconnect/conn-1",
    ...overrides,
  };
}

export function healthSystem(overrides: Partial<HealthSystemDto> = {}): HealthSystemDto {
  return {
    id: "prov-1",
    vendor: "epic",
    displayName: "Example Health",
    brandKey: "example-health",
    fhirBaseUrl: "https://fhir.example.test/api/FHIR/R4",
    portalUrl: "https://portal.example.test",
    environment: "prod",
    hasClientSecret: true,
    config: { titleTemplate: "{visitType} · {practitioner}", enabled: true },
    connection: connection(),
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

export function settings(overrides: Partial<SettingsDto> = {}): SettingsDto {
  return {
    // "UTC" and not a real IANA city zone: the owner's timezone is personal
    // configuration and must not appear in a tracked file.
    timezone: "UTC",
    calendarId: "primary",
    defaultTitleTemplate: "{visitType} · {practitioner}",
    defaultColorId: null,
    ghostColorId: "8",
    defaultArrivalOffsetMin: 15,
    windowPastDays: 90,
    syncBackoffUntil: null,
    mcpEnabled: true,
    portalLoginAttemptLimit: 3,
    portalApiBasePath: null,
    ...overrides,
  };
}

function run(overrides: Partial<RunDto> = {}): RunDto {
  return {
    id: "run-1",
    kind: "calendar",
    startedAt: "2026-09-21T11:07:00.000Z",
    finishedAt: "2026-09-21T11:07:04.000Z",
    ok: true,
    summary: {
      healthSystems: 1,
      encountersSeen: 4,
      eventsInserted: 2,
      eventsPatched: 1,
      eventsGhosted: 0,
      eventsRestored: 0,
      resourcesCached: 9,
      warnings: 0,
      warningCodes: [],
      portalVisits: 0,
      portalSkipped: 0,
      portalErrors: [],
      filteredView: false,
      backedOff: false,
      errors: [],
    },
    ...overrides,
  };
}

function alert(overrides: Partial<AlertDto> = {}): AlertDto {
  return {
    id: "alert-1",
    kind: "reconnect",
    subject: "health_system:prov-2",
    healthSystemId: "prov-2",
    trelloCardId: "card-1",
    openedAt: "2026-09-21T09:00:00.000Z",
    resolvedAt: null,
    ...overrides,
  };
}

export function mailInboxEntry(overrides: Partial<MailInboxEntryDto> = {}): MailInboxEntryDto {
  return {
    id: "mail-1",
    receivedAt: "2026-09-21T11:50:00.000Z",
    fromDomain: "mychart.example.test",
    subject: "Your MyChart login code",
    kind: "otp",
    consumedAt: null,
    expiresAt: "2026-09-21T12:00:00.000Z",
    rawSize: 1200,
    pendingCode: null,
    pendingUrl: null,
    ...overrides,
  };
}

export function mailSettings(overrides: Partial<MailSettingsDto> = {}): MailSettingsDto {
  return {
    allowlist: ["mychart.example.test", "google.com"],
    ...overrides,
  };
}

export function portalAccount(
  overrides: Partial<PortalAccountStatusDto> = {},
): PortalAccountStatusDto {
  return {
    healthSystemId: "prov-1",
    baseUrl: "https://portal.example.test",
    mountPath: "/MyChart",
    hasCredentials: true,
    hasSession: true,
    hasMfaContact: false,
    hasOtpSender: false,
    state: "active",
    lastLoginAt: "2026-09-21T06:00:00.000Z",
    lastOkAt: "2026-09-21T11:07:00.000Z",
    lastErrorCode: null,
    needsReauthSince: null,
    loginAttemptsToday: 0,
    updatedAt: "2026-09-21T11:07:00.000Z",
    signIn: { phase: "idle", code: null, startedAt: null, updatedAt: null },
    lastVisitCount: 2,
    ...overrides,
  };
}

export function brand(overrides: Partial<BrandDto> = {}): BrandDto {
  return {
    id: "example-health",
    name: "Example Health",
    aliases: ["Example Health System"],
    fhirBaseUrl: "https://fhir.example.test/api/FHIR/R4",
    portalUrl: "https://portal.example.test",
    locations: ["Example City", "Example Town"],
    ...overrides,
  };
}

export function overview(overrides: Partial<OverviewDto> = {}): OverviewDto {
  return {
    healthSystems: [
      healthSystem(),
      healthSystem({
        id: "prov-2",
        displayName: "Second Example Clinic",
        environment: "sandbox",
        hasClientSecret: false,
        connection: connection({
          id: "conn-2",
          healthSystemId: "prov-2",
          status: "needs_reauth",
          lastErrorCode: "invalid_grant",
          needsReauthSince: "2026-09-21T09:00:00.000Z",
          reconnectPath: "/reconnect/conn-2",
        }),
      }),
    ],
    google: {
      status: "connected",
      accountLabel: "o…r@example.test",
      accessExpiresAt: "2026-09-21T12:50:00.000Z",
      lastRefreshAt: "2026-09-21T11:50:00.000Z",
      needsReauthSince: null,
      connectedAt: "2026-09-01T00:00:00.000Z",
      calendarId: "primary",
    },
    openAlerts: [alert()],
    lastRuns: [run()],
    cacheCounts: [
      { healthSystemId: "prov-1", resourceType: "Observation", count: 42 },
      { healthSystemId: "prov-1", resourceType: "Condition", count: 7 },
      { healthSystemId: "prov-2", resourceType: "Condition", count: 3 },
    ],
    calendarEvents: { active: 5, ghost: 2 },
    mcp: { enabled: true, grants: 1, auditLast24h: 12, policyRules: 3 },
    settings: settings(),
    ...overrides,
  };
}
