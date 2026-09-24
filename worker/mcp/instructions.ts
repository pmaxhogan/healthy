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
  "systems. Start with get_health_summary. Every tool returns " +
  "{ items, total, matched, warnings, truncated, generatedAt } and accepts an " +
  "optional `jq` argument: a real jq program run server-side on `items` (after " +
  "the owner's exposure policy, before `limit`), so you can filter and project a " +
  "large result instead of reading all of it -- e.g. " +
  '`[.[] | select(.effective >= "2026-01-01") | {code, value}]`. ISO dates ' +
  "compare correctly as strings. A jq error comes back as a tool error carrying " +
  "jq's message; a `jq_result_empty` warning means your filter matched nothing " +
  "in a non-empty input, so check it before concluding there is no data.";
