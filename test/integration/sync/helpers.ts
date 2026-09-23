// Scaffolding for the sync integration tests.
//
// These run in real workerd against the real D1 schema, so what they exercise is
// the actual SQL, the actual AES-GCM sealing, and the actual Epic and Google
// clients -- only the transport is replaced. `stubUpstreams` answers by hostname:
// a per-provider FHIR server, Epic's token endpoint, Google's token endpoint, and
// an in-memory Google Calendar that stores what `buildEventBody` produced and
// serves it back through the same `events.list` shape the real API uses. That is
// what makes "the second run must not duplicate anything" a meaningful assertion
// rather than a mock returning whatever the test told it to.
//
// Nothing here names a real organisation, a real base URL, a real person or a
// real timezone. Hosts are `*.example.test` (reserved by RFC 6761), names are
// invented, and the zone is always "UTC".

import { env } from "cloudflare:test";

import { blindEventKey, blinderFor } from "../../../worker/db/blind.ts";
import { makeCtx } from "../../../worker/db/client.ts";
import { makeRepos } from "../../../worker/db/index.ts";
import { setSettings } from "../../../worker/db/settings.ts";

import type { Blinder } from "../../../worker/db/blind.ts";
import type { Ctx } from "../../../worker/db/client.ts";
import type { Repos } from "../../../worker/db/index.ts";
import type { Env } from "../../../worker/env.ts";
import type { Logger } from "../../../worker/lib/log.ts";
import type { SyncDeps } from "../../../worker/sync/deps.ts";
import type * as fhir4 from "fhir/r4";

/** A generated key per test isolate: nothing may commit one, not even a throwaway. */
function randomDataKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCodePoint(...bytes));
}

/** The URL of a `fetch` argument, in any of the three shapes it may take. */
function urlOf(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string") return new URL(input);
  return input instanceof URL ? input : new URL(input.url);
}

const DATA_KEY = randomDataKey();

/** 2026-06-15T12:00:00Z in unix seconds. An arbitrary fixed instant. */
export const T0 = 1_781_611_200;

/** Fake client credentials. Not secrets: they authenticate against a stub. */
const EPIC_CLIENT_ID = "epic-test-client";
const EPIC_CLIENT_SECRET = "epic-test-secret";
const GOOGLE_CLIENT_ID = "google-test-client";
const GOOGLE_CLIENT_SECRET = "google-test-secret";

/** The token endpoint one FHIR host advertises. Per host; see `handleToken`. */
function tokenUrlFor(host: string): string {
  return `https://auth.${host}/oauth2/token`;
}

export interface TestEnvOptions {
  trello?: boolean;
}

/**
 * A deliberately *clean* Env: the bindings, and fake secrets.
 *
 * Emphatically not `{ ...env }`. Miniflare loads `.dev.vars`, which holds the
 * developer's real `TRELLO_KEY`, `DATA_KEY` and Google client secret, so
 * spreading `env` would make "is Trello configured?" depend on the machine the
 * suite runs on -- and would put real credentials one stubbing mistake away from
 * a real API. Listing the bindings by hand is the only version of this that is
 * both deterministic and safe.
 */
export function syncEnv(options: TestEnvOptions = {}): Env {
  const bindings = env as unknown as Record<string, unknown>;
  const base = {
    DB: bindings.DB,
    OAUTH_KV: bindings.OAUTH_KV,
    ASSETS: bindings.ASSETS,
    HEALTHY_MCP: bindings.HEALTHY_MCP,
    FULL_REFRESH: bindings.FULL_REFRESH,
    PORTAL_SIGNIN: bindings.PORTAL_SIGNIN,
    DEV_MODE: "true",
    DATA_KEY,
    EPIC_CLIENT_ID_PROD: EPIC_CLIENT_ID,
    EPIC_CLIENT_ID_NONPROD: EPIC_CLIENT_ID,
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
  };
  const trello =
    options.trello === true
      ? {
          TRELLO_KEY: "trello-test-key",
          TRELLO_TOKEN: "trello-test-token",
          TRELLO_MUST_LIST_ID: "must-list",
          TRELLO_DONE_LIST_ID: "done-list",
        }
      : {};
  return { ...base, ...trello } as unknown as Env;
}

/** A clock the test moves by hand, so expiry and windows need no real waiting. */
export function clock(start = T0): { now: () => number; advance: (seconds: number) => void } {
  const state = { at: start };
  return {
    now: () => state.at,
    advance: (seconds) => {
      state.at += seconds;
    },
  };
}

export interface TestCtxOptions {
  now?: () => number;
  log?: Logger;
  trello?: boolean;
}

export function syncCtx(options: TestCtxOptions = {}): Ctx {
  const now = options.now ?? ((): number => T0);
  const trelloOption = options.trello === undefined ? {} : { trello: options.trello };
  return makeCtx(env.DB, syncEnv(trelloOption), options.log ? { now, log: options.log } : { now });
}

/** A logger that records its lines, for asserting on events and on redaction. */
export function recordingLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const emit = (level: string, event: string, fields?: Record<string, unknown>): void => {
    lines.push(JSON.stringify({ level, event, ...fields }));
  };
  const logger: Logger = {
    debug: (event, fields) => {
      emit("debug", event, fields);
    },
    info: (event, fields) => {
      emit("info", event, fields);
    },
    warn: (event, fields) => {
      emit("warn", event, fields);
    },
    error: (event, fields) => {
      emit("error", event, fields);
    },
    time: async (_event, fn) => fn(),
    child: () => logger,
  };
  return { log: logger, lines };
}

/** True when a recorded log line carries this event name. */
export function loggedEvent(lines: readonly string[], event: string): boolean {
  return lines.some((line) => (JSON.parse(line) as { event?: string }).event === event);
}

/** The fields of every recorded line carrying this event name, in order. */
export function loggedFields(lines: readonly string[], event: string): Record<string, unknown>[] {
  return lines
    .map((line) => JSON.parse(line) as { event?: string } & Record<string, unknown>)
    .filter((parsed) => parsed.event === event);
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export interface SeedProviderOptions {
  displayName?: string;
  host?: string;
  /** Seconds from the ctx clock until the seeded access token expires. */
  accessTtlSeconds?: number;
  config?: Record<string, unknown>;
  portalUrl?: string | null;
}

export interface SeededProvider {
  providerId: string;
  connectionId: string;
  fhirBaseUrl: string;
  patientId: string;
}

/**
 * A provider with a connected, usable connection.
 *
 * `accessTtlSeconds` is the lever the refresh tests pull: a token already inside
 * the five-minute skew forces the token manager down the refresh path on the very
 * first request.
 */
export async function seedConnectedProvider(
  ctx: Ctx,
  options: SeedProviderOptions = {},
): Promise<SeededProvider> {
  const repos = makeRepos(ctx);
  const host = options.host ?? "fhir.a.example.test";
  const fhirBaseUrl = `https://${host}/api/FHIR/R4`;
  const provider = await repos.providers.create({
    vendor: "epic",
    displayName: options.displayName ?? "A Example Health",
    fhirBaseUrl,
    portalUrl:
      options.portalUrl === undefined ? "https://portal.a.example.test" : options.portalUrl,
    environment: "sandbox",
    clientSecret: EPIC_CLIENT_SECRET,
    ...(options.config !== undefined && { config: options.config }),
  });
  const patientId = `patient-${host.split(".", 2)[1] ?? "x"}`;
  const connection = await repos.connections.upsertTokens(provider.id, {
    patientFhirId: patientId,
    accessToken: "seeded-access-token",
    accessExpiresAt: ctx.now() + (options.accessTtlSeconds ?? 3600),
    refreshToken: "seeded-refresh-token",
    scope: "patient/Encounter.rs",
    status: "connected",
  });
  return { providerId: provider.id, connectionId: connection.id, fhirBaseUrl, patientId };
}

/** The single Google account, connected with a comfortably valid token. */
export async function seedGoogle(ctx: Ctx, accessTtlSeconds = 3600): Promise<void> {
  const repos = makeRepos(ctx);
  await repos.google.upsertTokens({
    email: "owner@example.test",
    accessToken: "seeded-google-access",
    accessExpiresAt: ctx.now() + accessTtlSeconds,
    refreshToken: "seeded-google-refresh",
    scope: "https://www.googleapis.com/auth/calendar.events.owned",
    status: "connected",
  });
  await repos.google.markConnected();
}

/** The settings a sync needs. The zone is always "UTC"; see the module comment. */
export async function seedSettings(
  ctx: Ctx,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await setSettings(ctx, {
    timezone: "UTC",
    calendar_id: "primary",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// The in-memory Google Calendar
// ---------------------------------------------------------------------------

/** One stored event, as Google would hold it. */
type StoredEvent = Record<string, unknown> & { id: string };

/** Every test that does not care about calendar moves uses this one. */
const DEFAULT_CALENDAR = "primary";

interface FakeCalendar {
  /** Every event on every calendar this stub is holding, insertion order. */
  events: () => StoredEvent[];
  /** This app's events across every calendar, by `extendedProperties.private.key`. */
  byKey: () => Map<string, StoredEvent>;
  /** This app's events on one calendar only -- for asserting *where* an event
   * ended up after a target change, not just that it exists somewhere. */
  byKeyOn: (calendarId: string) => Map<string, StoredEvent>;
  /** Drop an event as though the owner deleted it by hand, on whichever calendar it is on. */
  remove: (eventId: string) => void;
  /** Put an event, that this app does not own, on a calendar (default the one every other test uses). */
  plant: (event: Record<string, unknown>, calendarId?: string) => void;
  inserts: number;
  patches: number;
  /** `events.move` calls that actually relocated an event. */
  moves: number;
}

function makeFakeCalendar(): {
  calendar: FakeCalendar;
  handle: (url: URL, init: RequestInit | undefined) => Response;
} {
  // Partitioned by calendar id, because that is the whole point of this stub:
  // a real Google event id is only ever valid on the calendar it was created
  // on, and a test that switches the target has to be able to prove that.
  const stores = new Map<string, StoredEvent[]>();
  const counters = { inserts: 0, patches: 0, moves: 0, nextId: 1 };

  const storeFor = (calendarId: string): StoredEvent[] => {
    let list = stores.get(calendarId);
    if (list === undefined) {
      list = [];
      stores.set(calendarId, list);
    }
    return list;
  };

  // Iterator#toArray would need the esnext.iterator lib, and this project's test
  // tsconfig is ES2022 only (the same tradeoff as Array#toSorted elsewhere).
  // eslint-disable-next-line unicorn/prefer-iterator-to-array
  const allEvents = (): StoredEvent[] => [...stores.values()].flat();

  /** Which calendar (if any) currently holds this event id. */
  const findCalendarOf = (eventId: string): string | null => {
    for (const [calendarId, list] of stores) {
      if (list.some((event) => event.id === eventId)) return calendarId;
    }
    return null;
  };

  const byKeyIn = (events: readonly StoredEvent[]): Map<string, StoredEvent> => {
    const out = new Map<string, StoredEvent>();
    for (const event of events) {
      const key = keyOf(event);
      if (key !== null) out.set(key, event);
    }
    return out;
  };

  const calendar: FakeCalendar = {
    events: allEvents,
    byKey: () => byKeyIn(allEvents()),
    byKeyOn: (calendarId) => byKeyIn(storeFor(calendarId)),
    remove: (eventId) => {
      const calendarId = findCalendarOf(eventId);
      if (calendarId === null) return;
      const list = storeFor(calendarId);
      const at = list.findIndex((event) => event.id === eventId);
      if (at !== -1) list.splice(at, 1);
    },
    plant: (event, calendarId = DEFAULT_CALENDAR) => {
      storeFor(calendarId).push({ ...event, id: `planted-${String(counters.nextId++)}` });
    },
    get inserts() {
      return counters.inserts;
    },
    get patches() {
      return counters.patches;
    },
    get moves() {
      return counters.moves;
    },
  };

  /** No event id in the URL: `events.list` or `events.insert`. */
  const handleCollection = (
    method: string,
    url: URL,
    calendarId: string,
    body: Record<string, unknown>,
  ): Response => {
    if (method === "GET") return listEvents(url, storeFor(calendarId));
    if (method !== "POST") return new Response(null, { status: 405 });
    counters.inserts += 1;
    const created: StoredEvent = {
      ...body,
      id: `google-${String(counters.nextId++)}`,
      status: "confirmed",
    };
    storeFor(calendarId).push(created);
    return Response.json(created);
  };

  /** `events.move`: relocate one event, keeping its id, into another calendar's list. */
  const handleMove = (url: URL, calendarId: string, eventId: string): Response => {
    const destination = url.searchParams.get("destination");
    const list = storeFor(calendarId);
    const at = list.findIndex((event) => event.id === eventId);
    // Gone from the source calendar: already moved, or genuinely deleted --
    // either way, the caller treats a null move like a null patch.
    if (at === -1 || destination === null) return notFound();
    const [moved] = list.splice(at, 1) as [StoredEvent];
    storeFor(destination).push(moved);
    counters.moves += 1;
    return Response.json(moved);
  };

  /** An id naming one event on one calendar: `events.get`/`patch`/`delete`. */
  const handleSingleEvent = (
    method: string,
    calendarId: string,
    eventId: string,
    body: Record<string, unknown>,
  ): Response => {
    const list = storeFor(calendarId);
    const at = list.findIndex((event) => event.id === eventId);
    if (method === "DELETE") {
      if (at !== -1) list.splice(at, 1);
      return new Response(null, { status: 204 });
    }
    // A missing event answers 404, exactly as Google does once the owner has
    // deleted it, or once an event id from a different calendar is used here --
    // which is the branch the sync has to survive either way.
    const existing = at === -1 ? undefined : list[at];
    if (existing === undefined) return notFound();
    if (method === "GET") return Response.json(existing);
    if (method !== "PATCH") return new Response(null, { status: 405 });
    counters.patches += 1;
    // `events.patch` is a merge, so mutating in place is what the real API does --
    // and it keeps the event where it was in the list.
    Object.assign(existing, body, { id: eventId });
    return Response.json(existing);
  };

  const handle = (url: URL, init: RequestInit | undefined): Response => {
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const calendarId = calendarIdFrom(url);
    const eventId = eventIdFrom(url);

    if (eventId === null) return handleCollection(method, url, calendarId, body);
    return isMove(url)
      ? handleMove(url, calendarId, eventId)
      : handleSingleEvent(method, calendarId, eventId, body);
  };

  return { calendar, handle };
}

function notFound(): Response {
  return Response.json({ error: { code: 404, message: "Not Found" } }, { status: 404 });
}

/** `.../events/<id>/move` -> true. Anything else, including a plain `.../events/<id>` -> false. */
function isMove(url: URL): boolean {
  return url.pathname.endsWith("/move");
}

/** `.../calendars/<id>/events...` -> the id, decoded. Defaults if the shape is unexpected. */
function calendarIdFrom(url: URL): string {
  const match = /\/calendars\/([^/]+)\/events/u.exec(url.pathname);
  return match?.[1] === undefined ? DEFAULT_CALENDAR : decodeURIComponent(match[1]);
}

/** `.../events/<id>` or `.../events/<id>/move` -> the id; `.../events` -> null. */
function eventIdFrom(url: URL): string | null {
  const match = /\/events\/([^/]+?)(?:\/move)?$/u.exec(url.pathname);
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
}

function keyOf(event: Record<string, unknown>): string | null {
  const properties = (event.extendedProperties as { private?: Record<string, string> } | undefined)
    ?.private;
  return properties?.healthy === "1" ? (properties.key ?? null) : null;
}

/**
 * `events.list`, honouring the two parameters the sync depends on.
 *
 * The `privateExtendedProperty` filter is the invariant that makes the sync safe,
 * so the stub enforces it rather than returning everything: a test can plant an
 * event the app does not own and prove it is never seen.
 */
function listEvents(url: URL, store: readonly StoredEvent[]): Response {
  const wanted = url.searchParams.get("privateExtendedProperty");
  const timeMin = url.searchParams.get("timeMin");
  const minMs = timeMin === null ? null : Date.parse(timeMin);
  const items = store.filter((event) => {
    if (wanted === "healthy=1" && keyOf(event) === null) return false;
    if (minMs === null) return true;
    const start = (event.start as { dateTime?: string } | undefined)?.dateTime;
    return start === undefined || Date.parse(start) >= minMs;
  });
  return Response.json({ items });
}

// ---------------------------------------------------------------------------
// The upstream stub
// ---------------------------------------------------------------------------

/** What one FHIR host answers. Mutable, so a test can change it between runs. */
export interface FhirServer {
  /** The Encounter search bundle. */
  encounters: fhir4.Bundle;
  /** Resources served by `read`, keyed `ResourceType/id`. */
  resources: Map<string, fhir4.FhirResource>;
  /** Extra search bundles for the full refresh, keyed by resource type. */
  searches: Map<string, fhir4.Bundle>;
  capability: fhir4.CapabilityStatement;
  /** Echoed back by the token endpoint, as Epic's `patient` field. */
  patientId: string;
  /** Set to answer `/metadata` with this status instead of a CapabilityStatement. */
  capabilityStatus: number | null;
  /** Set to answer the next Encounter search with this status instead. */
  encounterStatus: number | null;
  /** `Retry-After` on that status, in seconds. */
  retryAfter: string | null;
  /** Answer the token endpoint with `invalid_grant`. */
  tokenInvalidGrant: boolean;
  /** Answer the token endpoint with this status instead of a token. */
  tokenStatus: number | null;
  searchCalls: number;
  readCalls: number;
  tokenCalls: number;
}

export function fhirServer(overrides: Partial<FhirServer> = {}): FhirServer {
  return {
    encounters: emptyBundle(),
    resources: new Map(),
    searches: new Map(),
    capability: capabilityStatement(),
    patientId: "patient-a",
    capabilityStatus: null,
    encounterStatus: null,
    retryAfter: null,
    tokenInvalidGrant: false,
    tokenStatus: null,
    searchCalls: 0,
    readCalls: 0,
    tokenCalls: 0,
    ...overrides,
  };
}

export interface Upstreams {
  deps: SyncDeps;
  calendar: FakeCalendar;
  /** The Trello calls the alert path made, if any. */
  trelloCalls: { method: string; path: string }[];
  /** Cards the Trello stub has "created". */
  trelloCards: { name: string; desc: string }[];
  googleRefreshes: number;
}

/**
 * A `fetch` that answers every upstream the sync talks to.
 *
 * `servers` is keyed by hostname, so a two-provider test can make one
 * organisation fail while the other succeeds -- which is the whole point of the
 * per-provider isolation this suite is proving.
 */
export function stubUpstreams(servers: Record<string, FhirServer>): Upstreams {
  const { calendar, handle: handleCalendar } = makeFakeCalendar();
  const trelloCalls: { method: string; path: string }[] = [];
  const trelloCards: { name: string; desc: string }[] = [];
  const counters = { googleRefreshes: 0 };

  const answer = (url: URL, init: RequestInit | undefined): Response => {
    if (url.hostname === "www.googleapis.com") return handleCalendar(url, init);
    if (url.hostname === "oauth2.googleapis.com") {
      counters.googleRefreshes += 1;
      return Response.json({
        access_token: `google-access-${String(counters.googleRefreshes)}`,
        expires_in: 3600,
      });
    }
    // Each FHIR host advertises its own token endpoint at `auth.<host>`, so one
    // organisation's rejected grant cannot answer another's refresh.
    if (url.hostname.startsWith("auth.")) {
      const server = servers[url.hostname.slice("auth.".length)];
      return server === undefined ? new Response(null, { status: 502 }) : handleToken(server);
    }
    const server = servers[url.hostname];
    return server === undefined ? new Response(null, { status: 502 }) : handleFhir(server, url);
  };

  const fetchImpl: typeof fetch = (input, init) => Promise.resolve(answer(urlOf(input), init));

  const trelloFetch: typeof fetch = (input, init) => {
    const url = urlOf(input);
    const method = init?.method ?? "GET";
    trelloCalls.push({ method, path: url.pathname });
    if (method === "GET") return Promise.resolve(Response.json([]));
    trelloCards.push({
      name: url.searchParams.get("name") ?? "",
      desc: url.searchParams.get("desc") ?? "",
    });
    return Promise.resolve(Response.json({ id: `card-${String(trelloCards.length)}` }));
  };

  return {
    deps: {
      fetchImpl,
      trelloFetch,
      // Two attempts and a no-op sleep: a 429 test would otherwise spend seconds
      // of real time in `retriedFetch`'s backoff.
      retry: { maxAttempts: 2, sleep: () => Promise.resolve(), baseDelayMs: 1 },
      sleep: () => Promise.resolve(),
      origin: "https://healthy.example.test",
    },
    calendar,
    trelloCalls,
    trelloCards,
    get googleRefreshes() {
      return counters.googleRefreshes;
    },
  };
}

/** One organisation's token endpoint. The refresh grant is all the sync uses. */
function handleToken(server: FhirServer): Response {
  server.tokenCalls += 1;
  if (server.tokenStatus !== null)
    return new Response("token endpoint down", { status: server.tokenStatus });
  if (server.tokenInvalidGrant) {
    return Response.json(
      { error: "invalid_grant", error_description: "refresh token expired" },
      { status: 400 },
    );
  }
  return Response.json({
    access_token: "refreshed-access-token",
    refresh_token: "refreshed-refresh-token",
    expires_in: 3600,
    scope: "patient/Encounter.rs",
    patient: server.patientId,
    token_type: "Bearer",
  });
}

function handleFhir(server: FhirServer, url: URL): Response {
  if (url.pathname.endsWith("/.well-known/smart-configuration")) {
    return Response.json({
      authorization_endpoint: `https://auth.${url.hostname}/oauth2/authorize`,
      token_endpoint: tokenUrlFor(url.hostname),
      capabilities: ["launch-standalone", "permission-v2"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
    });
  }
  if (url.pathname.endsWith("/metadata")) {
    // 403 rather than 500 on purpose: the adapter reports it immediately as
    // `upstream_auth`, where a 5xx would spend `retriedFetch`'s real backoff.
    return server.capabilityStatus === null
      ? fhirJson(server.capability)
      : new Response(null, { status: server.capabilityStatus });
  }

  // Split rather than match: the path is `/api/FHIR/R4/<Type>[/<id>]`, and a
  // regex for it is both harder to read and something the unsafe-regex heuristic
  // objects to.
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const base = segments.lastIndexOf("R4");
  const resourceType = base === -1 ? undefined : segments.at(base + 1);
  if (resourceType === undefined) return new Response(null, { status: 404 });
  const resourceId = segments.at(base + 2);

  if (resourceId !== undefined) {
    server.readCalls += 1;
    const found = server.resources.get(`${resourceType}/${decodeURIComponent(resourceId)}`);
    return found === undefined ? new Response(null, { status: 404 }) : fhirJson(found);
  }

  if (resourceType === "Encounter") {
    server.searchCalls += 1;
    if (server.encounterStatus !== null) {
      const headers = server.retryAfter === null ? {} : { "retry-after": server.retryAfter };
      return new Response("rate limited", { status: server.encounterStatus, headers });
    }
    return fhirJson(server.encounters);
  }
  server.searchCalls += 1;
  return fhirJson(server.searches.get(resourceType) ?? emptyBundle());
}

function fhirJson(body: unknown): Response {
  return Response.json(body, { headers: { "content-type": "application/fhir+json" } });
}

// ---------------------------------------------------------------------------
// FHIR fixtures, built in memory
// ---------------------------------------------------------------------------

function emptyBundle(): fhir4.Bundle {
  return { resourceType: "Bundle", type: "searchset", total: 0, entry: [] };
}

/** A searchset Bundle over the given resources, all `search.mode: "match"`. */
export function searchBundle(resources: readonly fhir4.FhirResource[]): fhir4.Bundle {
  return {
    resourceType: "Bundle",
    type: "searchset",
    total: resources.length,
    entry: resources.map((resource) => ({ resource, search: { mode: "match" } })),
  };
}

export interface EncounterSpec {
  id: string;
  start: string;
  end?: string;
  status?: fhir4.Encounter["status"];
  visitType?: string;
  practitionerRef?: string;
  locationRefs?: string[];
  organizationRef?: string;
  classCode?: string;
}

export function encounter(spec: EncounterSpec): fhir4.Encounter {
  return {
    resourceType: "Encounter",
    id: spec.id,
    status: spec.status ?? "planned",
    class: {
      system: "https://terminology.hl7.org/CodeSystem/v3-ActCode",
      code: spec.classCode ?? "AMB",
    },
    type: [{ text: spec.visitType ?? "Office Visit" }],
    period: { start: spec.start, ...(spec.end !== undefined && { end: spec.end }) },
    participant: [{ individual: { reference: spec.practitionerRef ?? "Practitioner/prac-1" } }],
    location: (spec.locationRefs ?? ["Location/loc-1"]).map((reference) => ({
      location: { reference },
    })),
    serviceProvider: { reference: spec.organizationRef ?? "Organization/org-1" },
  };
}

function practitioner(id: string, family: string, qualification?: string): fhir4.Practitioner {
  return {
    resourceType: "Practitioner",
    id,
    name: [{ family, given: ["Test"] }],
    ...(qualification !== undefined && {
      qualification: [{ code: { text: qualification } }],
    }),
  };
}

function location(id: string, name: string): fhir4.Location {
  return {
    resourceType: "Location",
    id,
    name,
    address: { line: ["1 Test Way"], city: "Testville", state: "TS", postalCode: "00001" },
    telecom: [{ system: "phone", value: "555-0100" }],
  };
}

export function organization(id: string, name: string): fhir4.Organization {
  return { resourceType: "Organization", id, name };
}

/** The reference pool the Encounter fixtures point at. */
export function referencePool(): Map<string, fhir4.FhirResource> {
  return new Map<string, fhir4.FhirResource>([
    ["Practitioner/prac-1", practitioner("prac-1", "Alpha", "Cardiology")],
    ["Practitioner/prac-2", practitioner("prac-2", "Beta", "Dermatology")],
    ["Location/loc-1", location("loc-1", "Clinic Building A")],
    ["Location/loc-2", location("loc-2", "Heart Clinic")],
    ["Organization/org-1", organization("org-1", "Example Regional")],
  ]);
}

/**
 * A CapabilityStatement listing the types these tests exercise.
 *
 * `status` is deliberately absent from Encounter's search parameters, so the
 * status filter runs client-side -- which is the behaviour at organisations that
 * do not expose it, and the one more likely to be wrong.
 */
function capabilityStatement(
  extra: readonly fhir4.CapabilityStatementRestResource[] = [],
): fhir4.CapabilityStatement {
  return {
    resourceType: "CapabilityStatement",
    status: "active",
    date: "2026-01-01",
    kind: "instance",
    fhirVersion: "4.0.1",
    format: ["application/fhir+json"],
    rest: [
      {
        mode: "server",
        resource: [
          {
            type: "Patient",
            interaction: [{ code: "read" }],
            searchParam: [{ name: "_id", type: "token" }],
          },
          {
            type: "Encounter",
            interaction: [{ code: "read" }, { code: "search-type" }],
            searchParam: [
              { name: "patient", type: "reference" },
              { name: "date", type: "date" },
            ],
          },
          { type: "Practitioner", interaction: [{ code: "read" }] },
          { type: "Location", interaction: [{ code: "read" }] },
          { type: "Organization", interaction: [{ code: "read" }] },
          ...extra,
        ],
      },
    ],
  };
}

/**
 * The stored form of a logical event key (`<providerId>:<encounterId>` or
 * `<providerId>:csn:<csn>`): what the rows and the Google markers carry.
 */
export function sk(logicalKey: string): Promise<string> {
  return blindEventKey(blinderFor(DATA_KEY), logicalKey);
}

/** The blinder every sync test's repos use. */
export function syncBlinder(): Blinder {
  return blinderFor(DATA_KEY);
}

/** Every table, child before parent so the deletes never trip a foreign key. */
const TABLES = [
  "data_migrations",
  "login_attempts",
  "mail_inbox",
  "portal_visits",
  "portal_accounts",
  "mcp_policy",
  "mcp_audit",
  "run_log",
  "alerts",
  "calendar_events",
  "fhir_sync_state",
  "fhir_cache",
  "oauth_states",
  "connections",
  "providers",
  "settings",
];

/** Empty every table and put `google_account` back to its seeded state. */
export async function resetSyncDb(): Promise<void> {
  await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  await env.DB.prepare(
    `UPDATE google_account
        SET email_enc = NULL, access_token_enc = NULL, access_expires_at = NULL,
            refresh_token_enc = NULL, scope = NULL, status = 'disconnected',
            last_refresh_at = NULL, needs_reauth_since = NULL, lease_owner = NULL,
            lease_expires_at = NULL, connected_at = NULL, updated_at = 0
      WHERE id = 1`,
  ).run();
}

/** Repos over a sync test's ctx. */
export function syncRepos(ctx: Ctx): Repos {
  return makeRepos(ctx);
}
