/**
 * Stable, non-Epic codes `fhir_sync_state` records, shared between the writer
 * and every reader.
 *
 * A leaf module on purpose, with no import of its own: `worker/sync/full-refresh.ts`
 * (the writer) and `worker/mcp/coverage.ts` (a reader, reached from nearly every
 * MCP tool through `collect.ts`) both need these two strings, and `full-refresh.ts`
 * pulls in D1, the Durable Object runners and the rest of the sync engine. A
 * reader importing them from there would drag that whole graph into a context
 * that does not have the Cloudflare Workers ambient types in scope --
 * `test/unit/**` in particular, which type-checks against plain Node.
 */

/**
 * `fhir_sync_state.last_error_code` for a registry search entry this
 * organisation's CapabilityStatement does not support (dropped by
 * `filterSupported`).
 *
 * Recorded rather than left as "no row at all" so the MCP coverage layer
 * (`worker/mcp/coverage.ts`) can tell "this organisation does not offer this
 * type" apart from "the daily refresh has not reached it yet" -- exactly the
 * distinction `worker/db/repos/fhir-sync-state.ts`'s own module comment says
 * this table exists to draw.
 */
export const UNSUPPORTED_ERROR_CODE = "unsupported";

/**
 * The prefix on a synthetic `SyncWarning.code` recorded when one parameter set
 * of a multi-set entry (a `byCategory` search) was rejected outright while at
 * least one other set of the same entry succeeded.
 *
 * Read by `worker/mcp/coverage.ts` to mark the pair `partial` rather than `ok`:
 * a category that came back empty because it does not apply is silence, but a
 * category Epic refused to run is not the same as "no care plans of that kind".
 */
export const CATEGORY_REJECTED_PREFIX = "category_rejected:";
