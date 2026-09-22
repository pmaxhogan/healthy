/**
 * The seams the admin API and the OAuth routes reach the outside world through.
 *
 * Everything in here is a *port*: an interface owned by the caller, with one
 * live implementation and a test override. There are two unrelated reasons for
 * that, and both matter.
 *
 * 1. **Testing.** `fetch` is a port, so an integration test can stand in for
 *    Epic's token endpoint, Google's, and Trello's without `vi.stubGlobal` --
 *    which is unreliable inside workerd, where the Worker and the test are
 *    different realms.
 *
 * 2. **A narrow contract across three authors.** The sync engine (`worker/sync/`)
 *    and the MCP grant store (`worker/mcp/grants.ts`) are written separately. The
 *    interfaces below are the only shapes /api depends on, so a change inside
 *    either module shows up here as one type error rather than as a dozen broken
 *    handlers -- and `setPorts` lets a test replace either without touching the
 *    real one.
 *
 * The live implementations are the defaults, so nothing has to be wired at
 * startup: `worker/index.ts` is untouched by this file.
 */

import { createTrelloAlerts } from "../alerts/trello.ts";
import { AppError } from "../lib/errors.ts";
import { listGrants, revokeGrant } from "../mcp/grants.ts";
import {
  getGoogleCalendarFor,
  refreshConnectionToken,
  resolveReconnectAlert,
  runCalendarSync,
  startFullRefresh,
} from "../sync/index.ts";

import type { TrelloAlerts } from "../alerts/trello.ts";
import type { Ctx } from "../db/client.ts";
import type { Env } from "../env.ts";
import type { CalendarClient } from "../google/calendar.ts";
import type { McpGrantDto } from "@shared/types.ts";

/** Which connection a reconnect alert is about. */
type ReconnectSubject = "google" | { providerId: string };

/**
 * The sync engine's public surface, as the admin API uses it.
 *
 * The run entry points resolve with `unknown` on purpose. The engine reports a run
 * summary, and the API neither reads nor forwards it: a manual run is kicked off in
 * `waitUntil` and has not finished by the time the 202 is written. Typing the
 * return as `unknown` is what keeps this contract from having to track the
 * summary's shape, which belongs to `worker/sync/`.
 *
 * `startFullRefresh` is the one that is *not* fire-and-forget, and it is the one
 * port method whose answer the API reads. A refresh outlives a `waitUntil`, so it is
 * queued on a Durable Object instead; the call is a storage write, it is awaited,
 * and `started: false` means one was already running for that provider.
 */
interface SyncPort {
  runCalendarSync(
    ctx: Ctx,
    options: { providerIds?: string[]; trigger: "manual" },
  ): Promise<unknown>;
  startFullRefresh(ctx: Ctx, options: { providerId: string }): Promise<{ started: boolean }>;
  /** Forces a token refresh even when the current one has not expired. */
  refreshConnectionToken(ctx: Ctx, providerId: string, options: { force: true }): Promise<unknown>;
  /** A calendar client wired to the stored Google tokens, refresh included. */
  getGoogleCalendarFor(ctx: Ctx): Promise<CalendarClient>;
  /** Closes the open reconnect alert for a subject, Trello card and all. */
  resolveReconnectAlert(ctx: Ctx, subject: ReconnectSubject): Promise<void>;
}

/**
 * One MCP grant as the store hands it over.
 *
 * `id` is the only field required. Everything else is optional because the shape
 * ultimately comes from `@cloudflare/workers-oauth-provider`, which owns it and has
 * changed it between releases -- so the projection in `routes/mcp.ts` fills the gaps
 * rather than trusting them to be there. A full `McpGrantDto` satisfies this, which
 * is what the live implementation returns.
 */
export type GrantLike = { id: string } & Partial<Omit<McpGrantDto, "id">>;

interface GrantsPort {
  listGrants(env: Env): Promise<readonly GrantLike[]>;
  /** False when the grant was already gone. */
  revokeGrant(env: Env, grantId: string): Promise<boolean>;
}

export interface Ports {
  /** Every outbound HTTP call the API and OAuth routes make goes through this. */
  fetch: typeof fetch;
  sync: SyncPort;
  grants: GrantsPort;
  /** Built per request so the injected fetch is the current one. */
  trello(env: Env, fetchImpl: typeof fetch): TrelloAlerts;
}

/**
 * The Trello client, from the four Worker secrets.
 *
 * Throws `not_connected` rather than `internal` when they are unset: a deployment
 * that has not configured Trello is a legitimate state (alerts are simply off),
 * and the UI shows the difference.
 */
function liveTrello(env: Env, fetchImpl: typeof fetch): TrelloAlerts {
  const { TRELLO_KEY, TRELLO_TOKEN, TRELLO_MUST_LIST_ID, TRELLO_DONE_LIST_ID } = env;
  if (
    TRELLO_KEY === undefined ||
    TRELLO_TOKEN === undefined ||
    TRELLO_MUST_LIST_ID === undefined ||
    TRELLO_DONE_LIST_ID === undefined
  ) {
    throw new AppError("not_connected", "Trello alerting is not configured");
  }
  return createTrelloAlerts({
    key: TRELLO_KEY,
    token: TRELLO_TOKEN,
    mustListId: TRELLO_MUST_LIST_ID,
    doneListId: TRELLO_DONE_LIST_ID,
    fetchImpl,
  });
}

function defaults(): Ports {
  return {
    // Bound, not passed by reference: an unbound `fetch` loses its `this` in
    // some runtimes, and the integration tests replace this field wholesale.
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    sync: {
      runCalendarSync,
      startFullRefresh,
      refreshConnectionToken,
      getGoogleCalendarFor,
      resolveReconnectAlert,
    },
    grants: { listGrants, revokeGrant },
    trello: liveTrello,
  };
}

// Module scope rather than a parameter on every handler: the ports are process
// configuration, they never vary per request, and threading them through a dozen
// signatures would be noise. A one-field holder rather than a bare `let`, so the
// mutation is greppable.
const state = { ports: defaults() };

/** The current ports. Call it inside a handler, never at module load. */
export function getPorts(): Ports {
  return state.ports;
}

/** Wire (or, in a test, replace) some of the ports. Returns the previous set. */
export function setPorts(overrides: Partial<Ports>): Ports {
  const previous = state.ports;
  state.ports = { ...previous, ...overrides };
  return previous;
}

/** Put the live ports back. Tests call this in `afterEach`. */
export function resetPorts(): void {
  state.ports = defaults();
}
