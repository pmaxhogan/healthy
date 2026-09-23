// Shared scaffolding for the /api and /oauth integration tests.
//
// These run in real workerd against the real D1 schema, and they drive the app the
// way a browser does: `POST /auth/login` for a session cookie, then requests
// carrying that cookie, an `Origin` and the CSRF header. Nothing here reaches past
// the HTTP surface except the seeding helpers, which use the repos directly.
//
// ### Why `app.fetch` and not `SELF`
//
// `wrangler.jsonc` necessarily ships `DEV_MODE: "false"` (it is what production
// deploys from) and every other value here is a secret, so a `SELF` request cannot
// clear gate 1. The bindings -- real D1, real assets -- still come from
// `cloudflare:test`.
//
// ### The DATA_KEY has to be the same one
//
// Everything sealed by a request must be openable by a seeding helper and vice
// versa, so both go through `TEST_ENV`. `test/integration/db/helpers.ts` mints its
// own key for its own purposes; do not build a Ctx with that one here.

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach } from "vitest";

import { setPorts } from "../../../worker/api/ports.ts";
import { app } from "../../../worker/app.ts";
import { MIN_PBKDF2_ITERATIONS, hashPassword } from "../../../worker/auth/password.ts";
import { blindEventKey, blinderFor } from "../../../worker/db/blind.ts";
import { makeCtx } from "../../../worker/db/client.ts";
import { makeRepos } from "../../../worker/db/index.ts";

import type { Ports } from "../../../worker/api/ports.ts";
import type { Ctx } from "../../../worker/db/client.ts";
import type { Repos } from "../../../worker/db/index.ts";
import type { Env } from "../../../worker/env.ts";

// Re-exported so a test file needs one import: the ports and the fixtures are used
// together wherever either is used.
export { resetPorts } from "../../../worker/api/ports.ts";

export const ORIGIN = "https://healthy.example";
const PASSWORD = "the-owners-password";

/** The CSRF header every state-changing /api request must carry. */
export const CSRF = { "x-healthy-csrf": "1" } as const;

function randomDataKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCodePoint(...bytes));
}

/**
 * The secrets these tests need.
 *
 * Generated rather than fixed, for the key: nothing may commit an AES key, not even
 * a throwaway one, because a committed key is indistinguishable from a leaked one to
 * every scanner that will look at this repository.
 */
const overrides: Partial<Env> = {
  DEV_MODE: "true",
  PASSWORD_HASH: await hashPassword(PASSWORD, MIN_PBKDF2_ITERATIONS),
  SESSION_SECRET: "integration-test-signing-material",
  DATA_KEY: randomDataKey(),
  GOOGLE_CLIENT_ID: "test-google-client-id",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
  EPIC_CLIENT_ID_NONPROD: "test-epic-nonprod-client-id",
  EPIC_CLIENT_ID_PROD: "test-epic-prod-client-id",
  TRELLO_KEY: "test-trello-key",
  TRELLO_TOKEN: "test-trello-token",
  TRELLO_MUST_LIST_ID: "must-list",
  TRELLO_DONE_LIST_ID: "done-list",
};

/**
 * The cast is load-bearing only for `HEALTHY_MCP`: `wrangler types` narrows it to
 * `DurableObjectNamespace<HealthyMcp>`, which is not assignable to the
 * unparameterised `DurableObjectNamespace` that worker/env.ts declares. `overrides`
 * is typed, so the cast cannot hide a typo in one of them.
 */
const TEST_ENV = { ...env, ...overrides } as unknown as Env;

export function testCtx(): Ctx {
  return makeCtx(env.DB, TEST_ENV);
}

export function testRepos(): Repos {
  return makeRepos(testCtx());
}

/** One request through the whole gate chain. */
export async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(ORIGIN + path, init), TEST_ENV, ctx);
  // Waits for anything the handler passed to `waitUntil`, so a background sync
  // cannot leak into the next test.
  await waitOnExecutionContext(ctx);
  return response;
}

/** Exchange the password for a session cookie. */
async function login(): Promise<string> {
  const form = new FormData();
  form.set("password", PASSWORD);
  const response = await call("/auth/login", {
    method: "POST",
    headers: { origin: ORIGIN },
    body: form,
  });
  const header = response.headers.get("set-cookie") ?? "";
  return header.split(";", 1)[0] ?? "";
}

export interface Session {
  get(path: string): Promise<Response>;
  /** A state-changing request, with the CSRF header and an Origin. */
  send(method: string, path: string, body?: unknown): Promise<Response>;
  cookie: string;
}

/** A logged-in caller. Build one per test, after `resetDb()`. */
async function session(): Promise<Session> {
  const cookie = await login();
  return {
    cookie,
    get: (path) => call(path, { headers: { cookie } }),
    send: (method, path, body) =>
      call(path, {
        method,
        headers: {
          cookie,
          origin: ORIGIN,
          ...CSRF,
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
  };
}

/** A JSON body, typed by the caller's expectation. */
export async function json<T>(response: Response): Promise<T> {
  return await response.json();
}

/** One route of a stubbed upstream: a URL predicate and what to answer with. */
export interface StubRoute {
  /** Matched against the full request URL. */
  match: string | RegExp;
  method?: string;
  status?: number;
  body?: unknown;
  /** Full control, when a route needs to inspect the request. */
  respond?: (request: Request) => Response | Promise<Response>;
}

export interface FetchStub {
  fetchImpl: typeof fetch;
  /** Every request the code under test made, in order. */
  requests: { method: string; url: string; body: string }[];
}

/**
 * A fetch that answers the given routes and fails loudly on anything else.
 *
 * Loudly is the point: a test that silently receives an empty 200 from an upstream
 * it forgot to stub passes for the wrong reason. An unmatched URL throws, which
 * surfaces as the request failing.
 */
export function stubFetch(routes: readonly StubRoute[]): FetchStub {
  const requests: { method: string; url: string; body: string }[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = request.url;
    const body = request.method === "GET" ? "" : await request.clone().text();
    requests.push({ method: request.method, url, body });

    for (const route of routes) {
      const methodOk = route.method === undefined || route.method === request.method;
      const urlOk =
        typeof route.match === "string" ? url.includes(route.match) : route.match.test(url);
      if (!methodOk || !urlOk) continue;
      if (route.respond !== undefined) return route.respond(request);
      return Response.json(route.body ?? {}, {
        status: route.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`no stub for ${request.method} ${url}`);
  };
  return { fetchImpl: fetchImpl, requests };
}

/** Install ports for one test. Pair with `resetPorts()` in `afterEach`. */
export function usePorts(overridePorts: Partial<Ports>): void {
  setPorts(overridePorts);
}

/**
 * A clean database and a logged-in caller, per test.
 *
 * Returns an accessor rather than assigning to a `let` in the test file: a
 * top-level binding written from inside a hook is exactly the pattern that makes a
 * shared fixture hard to follow, and eslint refuses it.
 *
 * ```ts
 * const owner = freshOwner();
 * it("...", async () => { await owner().get("/api/overview"); });
 * ```
 */
export function freshOwner(): () => Session {
  const state: { session: Session | null } = { session: null };
  beforeEach(async () => {
    await resetDb();
    state.session = await session();
  });
  return () => {
    if (state.session === null) throw new Error("no session: called outside a test?");
    return state.session;
  };
}

// Every table, child before parent so the deletes never trip a foreign key.
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
  "health_systems",
  "settings",
];

/** The stored form of a logical event key, under this suite's DATA_KEY. */
export function blindKey(logicalKey: string): Promise<string> {
  return blindEventKey(blinderFor(TEST_ENV), logicalKey);
}

/**
 * Empty every table and put `google_account` back to its seeded state.
 *
 * The pool shares one D1 instance across the tests in a file, so each test starts
 * clean only if it says so. Call this from `beforeEach`.
 */
async function resetDb(): Promise<void> {
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

/** A sandbox health system pointing at a URL no test ever really reaches. */
export const TEST_FHIR_BASE = "https://fhir.example.test/R4";

export async function seedHealthSystem(
  options: { clientSecret?: string; displayName?: string } = {},
): Promise<string> {
  const repos = testRepos();
  const healthSystem = await repos.healthSystems.create({
    vendor: "epic",
    displayName: options.displayName ?? "Example Health",
    fhirBaseUrl: TEST_FHIR_BASE,
    portalUrl: "https://portal.example.test",
    environment: "sandbox",
    ...(options.clientSecret !== undefined && { clientSecret: options.clientSecret }),
  });
  return healthSystem.id;
}
