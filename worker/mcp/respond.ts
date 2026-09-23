/**
 * The only place an MCP answer is serialised.
 *
 * Every tool ends with `respond(...)` or `toolError(...)`. `respond` is where
 * {@link applyPolicy} is called, and it is called on the way to
 * `JSON.stringify` -- there is no path from a tool to a `content` block that
 * does not pass through the filter, which is what makes "denied data never
 * leaves" a property of the code rather than of everyone remembering.
 *
 * The envelope is fixed:
 *
 *   { items, total, warnings, truncated, generatedAt }      (+ raw, when asked for)
 *
 * `truncated` is decided AFTER filtering, deliberately. Slicing to `limit` first
 * would let a deny rule turn a full page into a short one and the caller would
 * have no way to tell a filtered page from the end of the data.
 *
 * `limit` is optional and there is no default and no ceiling: an absent `limit`
 * means every matching item comes back, however many there are. `truncated` is
 * therefore only ever true when the caller passed a `limit` and it actually cut
 * something -- it is never how a tool quietly caps its own answer. `total` is
 * the count before that cut, so "10 of 340" is always answerable from the
 * response alone.
 *
 * Errors are `isError` content carrying a stable code and a fixed sentence. Never
 * a stack, never an upstream body, never a resource: an upstream error message
 * from a health system can quote the record that caused it.
 */

import { toIso } from "../lib/time.ts";
import { applyPolicy, sortedWarnings } from "../policy/filter.ts";

import type { RawEntry } from "../policy/filter.ts";
import type { PolicyRules } from "../policy/rules.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Stable error codes a tool can answer with. */
export type ToolErrorCode =
  | "mcp_disabled"
  | "policy_denied"
  | "not_found"
  | "not_connected"
  | "document_cap_reached"
  | "unsupported_document"
  | "upstream_error"
  | "internal_error";

/**
 * One sentence per code. Fixed text, so nothing upstream can reach the client.
 *
 * A `Map` rather than a record: the lookup is by a value that came off the wire in
 * some paths, and a keyed read of a plain object is the shape that makes
 * prototype pollution possible.
 */
const ERROR_MESSAGES = new Map<ToolErrorCode, string>([
  ["mcp_disabled", "the MCP surface is switched off in this deployment's settings"],
  ["policy_denied", "the owner's exposure policy denies this tool"],
  ["not_found", "no such record in the local cache"],
  ["not_connected", "that provider has no usable connection right now"],
  ["document_cap_reached", "daily document cap reached"],
  ["unsupported_document", "the document is not in a format this server can turn into text"],
  ["upstream_error", "the health system could not be reached or refused the request"],
  ["internal_error", "the request failed"],
]);

/** What a tool handler hands back, before the audit wrapper turns it into a result. */
export interface ToolOutcome {
  result: CallToolResult;
  /** Items actually returned, for the audit row. */
  resultCount: number;
  /** Provider ids the call read from, for the audit row. Ids, never names. */
  providerIds: string[];
  /** Null on success; the stable code otherwise. */
  errorCode: ToolErrorCode | null;
}

function textResult(payload: unknown, isError: boolean): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError && { isError: true }),
  };
}

/** An `isError` answer. The only way a tool reports failure. */
export function toolError(
  code: ToolErrorCode,
  options: { providerIds?: string[]; detail?: string } = {},
): ToolOutcome {
  return {
    result: textResult(
      {
        error: code,
        message: ERROR_MESSAGES.get(code) ?? "the request failed",
        ...(options.detail !== undefined && { detail: options.detail }),
      },
      true,
    ),
    resultCount: 0,
    providerIds: options.providerIds ?? [],
    errorCode: code,
  };
}

export interface RespondInput {
  /** Tool name, for the `tool` deny rule and the audit row. */
  tool: string;
  rules: PolicyRules;
  /** Every item the tool matched, unlimited; `limit` is applied here. */
  items: readonly unknown[];
  /** The raw FHIR behind `items`, in the same order. Omitted unless requested. */
  rawItems?: readonly RawEntry[] | undefined;
  /** Omitted (or undefined) means no limit: every matching item is returned. */
  limit?: number | undefined;
  /** Provider ids read from, for the audit row. */
  providerIds: string[];
  /** Notes the tool itself wants to pass on (cache staleness, sync warnings). */
  warnings?: readonly string[] | undefined;
  /** Unix seconds. */
  now: number;
}

/**
 * Filter, page, serialise.
 *
 * `items` and `rawItems` stay index-aligned through the filter: both are judged
 * by the same resource-type and provider rules, so an item and the raw resource
 * behind it are always dropped together.
 */
export function respond(input: RespondInput): ToolOutcome {
  const filtered = applyPolicy({
    tool: input.tool,
    items: input.items,
    rawItems: input.rawItems,
    rules: input.rules,
  });

  if (filtered.denied) {
    return toolError("policy_denied", { providerIds: input.providerIds });
  }

  const limit = input.limit === undefined ? undefined : Math.max(0, Math.trunc(input.limit));
  const items = limit === undefined ? filtered.items : filtered.items.slice(0, limit);
  const truncated = limit !== undefined && filtered.items.length > items.length;
  const warnings = sortedWarnings([...(input.warnings ?? []), ...filtered.warnings]);

  const payload: Record<string, unknown> = {
    items,
    total: filtered.items.length,
    ...(input.rawItems !== undefined && {
      raw: limit === undefined ? filtered.rawItems : filtered.rawItems.slice(0, limit),
    }),
    warnings,
    truncated,
    generatedAt: toIso(input.now),
  };

  return {
    result: textResult(payload, false),
    resultCount: items.length,
    providerIds: input.providerIds,
    errorCode: null,
  };
}
