/**
 * The wrapper every tool is registered through.
 *
 * It does four things, in this order, so that no tool has to remember any of
 * them:
 *
 *  1. Refuses everything when `settings.mcp_enabled` is false. One switch, and it
 *     is checked before a single row is read.
 *  2. Loads the exposure rules once per call and refuses a denied tool before it
 *     reads anything -- a denied tool costs one settings read and one policy read,
 *     not a cache scan. (`applyPolicy` enforces the same rule again on the way
 *     out; this is the cheap path, not the trusted one.)
 *  3. Turns any thrown error into an `isError` answer with a stable code. A
 *     health system's error body can quote the record that caused it, so no
 *     upstream message and no stack ever reaches the client.
 *  4. Writes exactly one `mcp_audit` row per call: which tool, which health systems by
 *     id, how many items, whether it worked, how long it took. The row has
 *     nowhere to put content and this function never offers it any.
 *
 * Retention is handled here too, sampled rather than scheduled: roughly one call
 * in eighty also prunes rows past a year. That keeps the daily cron free of a
 * dependency on this module and means an unused deployment never accumulates.
 */

import { isAppError } from "../lib/errors.ts";
import { isToolDenied } from "../policy/rules.ts";

import { toolError } from "./respond.ts";

import type { ToolDeps } from "./deps.ts";
import type { ToolErrorCode, ToolOutcome } from "./respond.ts";
import type { ErrorCode } from "../lib/errors.ts";
import type { PolicyRules } from "../policy/rules.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** What the wrapper hands each tool: the rules it must answer under, and a clock. */
interface ToolRun {
  rules: PolicyRules;
  /** Unix seconds, read once so every timestamp in one answer agrees. */
  now: number;
}

/** A tool body: takes its validated arguments, returns an outcome. */
export type ToolBody<Args> = (args: Args, run: ToolRun) => Promise<ToolOutcome>;

/** How an `AppError` from the layers below is reported to the client. */
const ERROR_CODE_MAP: Partial<Record<ErrorCode, ToolErrorCode>> = {
  policy_denied: "policy_denied",
  not_found: "not_found",
  not_connected: "not_connected",
  needs_reauth: "not_connected",
  upstream_auth: "upstream_error",
  upstream_error: "upstream_error",
  upstream_unavailable: "upstream_error",
  rate_limited: "upstream_error",
};

function classify(error: unknown): ToolErrorCode {
  return (isAppError(error) ? ERROR_CODE_MAP[error.code] : undefined) ?? "internal_error";
}

/**
 * One call in ~85, using the CSPRNG.
 *
 * `Math.random()` would do, but `sonarjs/pseudo-random` is right that reaching
 * for it in a Worker is a habit worth not having, and `crypto` is already here.
 */
function shouldPrune(): boolean {
  const [byte = 255] = crypto.getRandomValues(new Uint8Array(1));
  return byte < 3;
}

/**
 * Wrap one tool body into the callback `McpServer.registerTool` takes.
 *
 * The audit write is awaited inside the same request: a Durable Object can be
 * evicted the moment the response is written, so a fire-and-forget row is a row
 * that sometimes does not exist -- and an audit trail with gaps is worse than
 * none, because it looks complete.
 */
export function withAudit<Args>(
  deps: ToolDeps,
  tool: string,
  body: ToolBody<Args>,
): (args: Args) => Promise<CallToolResult> {
  return async (args: Args): Promise<CallToolResult> => {
    const startedMs = Date.now();
    let outcome: ToolOutcome;
    try {
      // Fresh settings and fresh rules for every call: a Durable Object session
      // lives for as long as the client keeps it open.
      deps.beginCall();
      if (await deps.mcpEnabled()) {
        const rules = await deps.rules();
        outcome = isToolDenied(rules, tool)
          ? toolError("policy_denied")
          : await body(args, { rules, now: deps.now() });
      } else {
        outcome = toolError("mcp_disabled");
      }
    } catch (error) {
      const code = classify(error);
      // The logger redacts, and only the code and the tool name go in regardless.
      deps.log.warn("mcp.tool_failed", { tool, errorCode: code });
      outcome = toolError(code);
    }

    await writeAudit(deps, tool, outcome, Date.now() - startedMs);
    return outcome.result;
  };
}

async function writeAudit(
  deps: ToolDeps,
  tool: string,
  outcome: ToolOutcome,
  durationMs: number,
): Promise<void> {
  try {
    await deps.recordAudit({
      tool,
      clientId: deps.caller.clientId,
      grantId: deps.caller.grantId,
      healthSystemIds: outcome.healthSystemIds,
      resultCount: outcome.resultCount,
      ok: outcome.errorCode === null,
      errorCode: outcome.errorCode,
      durationMs,
    });
    if (shouldPrune()) await deps.pruneAudit();
  } catch (error) {
    // A failed audit write must not turn a good answer into an error: the tool
    // has already run and the data has already been filtered. It is logged as a
    // warning, which is the signal that the trail has a hole in it.
    deps.log.warn("mcp.audit_write_failed", { tool, errorCode: classify(error) });
  }
}
