/**
 * The sync engine's public surface.
 *
 * Deliberately small: exactly what the admin API, the MCP server and
 * `worker/index.ts` need, so nothing outside this directory ends up depending on
 * the mapping, the diff or the token internals. The unit tests reach into those
 * modules directly, which is the right asymmetry -- a test may know how something
 * works, a consumer may not.
 *
 * `runFullRefresh` is deliberately absent. Its only caller is the cron dispatcher,
 * which lives inside this directory, and nothing outside it should be able to start
 * a refresh that a `waitUntil` will cancel half way through.
 *
 * **How to invoke a run from a request handler: never `await` it.** A sync talks
 * to two upstreams and can take far longer than a request should, so the admin
 * endpoints do
 *
 * ```ts
 * ectx.waitUntil(runCalendarSync(ctx, { trigger: "manual", healthSystemIds: [id] }));
 * return json({ started: true });
 * ```
 *
 * `runCalendarSync`, `runFullRefresh` and `runTokenKeepalive` never throw and each
 * writes its own `run_log` row, so a fire-and-forget call is always recorded and
 * `GET /api/runs` is how the UI reports what happened. `refreshConnectionToken` is
 * the exception: it is driven by a button that has to show the owner an error, so
 * it throws, and it is short enough to await.
 *
 * **`runFullRefresh` is the exception to the exception.** `waitUntil` is cancelled
 * about thirty seconds after the response, and a large record takes longer, so a
 * request must not start one that way: it calls `startFullRefresh`, which queues the
 * work on a Durable Object and returns. Cron still calls `runFullRefresh` directly,
 * because a scheduled invocation has the wall clock for it.
 */

export { runCalendarSync } from "./calendar-sync.ts";
export { startFullRefresh } from "./runner.ts";
/**
 * The portal sign-in runner's three entry points.
 *
 * All three go through the Durable Object, which is the whole point: a sign-in
 * waits for an emailed code, so it cannot happen inside the request that asked for
 * it. `portalSignInState` is what the admin UI polls while it does.
 */
export { portalSignInState, startPortalSignIn, startPortalSync } from "./portal-runner.ts";
export { refreshConnectionToken } from "./keepalive.ts";
export { handleScheduled } from "./scheduled.ts";

// For the MCP's on-demand reads (a Binary, a Practitioner the cache has not seen):
// a FHIR client with the connection's token management already wired in.
export { getFhirClientFor } from "./tokens.ts";
export { getGoogleCalendarFor } from "./google-tokens.ts";

export { resolveReconnectAlert } from "./alerts.ts";
/**
 * Whether a `fhir_cache` row is one of the discovery documents.
 *
 * Every consumer of that table needs this. The SMART configuration and the
 * capability index are cached there under the synthetic resource types `_smart`
 * and `_capability`, so an overview panel or an MCP health summary that counted
 * `countsByType()` rows as clinical resources would report two phantom
 * "resources" per health system. See `discovery.ts` for why they live there.
 */
export { isDiscoveryCacheType } from "./discovery.ts";
