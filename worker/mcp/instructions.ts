/**
 * The server instructions a client receives on `initialize`.
 *
 * Shared by the Durable Object server (`server.ts`) and the admin console's
 * in-process one (`admin-call.ts`), so the two cannot describe the surface
 * differently. Short on purpose: a client typically puts this into the model's
 * context on every turn, and each tool's own description carries the detail.
 */
export const MCP_INSTRUCTIONS =
  "A read-only copy of one person's health record, cached from their health " +
  "systems. Start with get_health_summary. For 'what conditions do I have', " +
  'use get_conditions with category ["problem-list-item"] or collapse: true. ' +
  "Every tool that reads a resource " +
  "type returns { items, total, matched, coverage, warnings, truncated, " +
  "generatedAt } and accepts an optional `jq` argument: a real jq program run " +
  "server-side on `items` (after the owner's exposure policy, before `limit`), " +
  "so you can filter and project a large result instead of reading all of it. " +
  "The filter runs on the items array; every value it emits becomes one " +
  "element of items -- so write " +
  '`.[] | select(.effective >= "2026-01-01") | {code, value}`, not that ' +
  "wrapped in `[...]` (which would emit one output, itself an array, giving " +
  "you a one-element items). ISO dates compare correctly as strings. A jq " +
  "error comes back as a tool error carrying jq's message; a `jq_result_empty` " +
  "warning means your filter matched nothing in a non-empty input, so check it " +
  "before concluding there is no data. `coverage` says, per health system and " +
  "resource type, whether the cache is `ok`, `partial` (one part of the search " +
  "was rejected), `stale`, `failed`, `unsupported` (the health system does not " +
  "offer that type -- not a problem), or `never` synced yet. Any pair that is " +
  "not ok or unsupported also gets a plain-text `warnings` entry -- " +
  "`sync_failed:<type>:<healthSystemId>:<errorCode>`, " +
  "`never_synced:<type>:<healthSystemId>`, `stale:<type>:<healthSystemId>:<age>h` " +
  "or `partial:<type>:<healthSystemId>` -- whether or not `items` is empty, so " +
  "a gap in one health system cannot hide behind another health system's data. " +
  "Check `coverage` and `warnings` -- especially `incomplete_no_data_is_not_absence` " +
  "on an empty `items` -- before concluding something does not exist: it may " +
  "mean the last refresh failed or has not run.";
