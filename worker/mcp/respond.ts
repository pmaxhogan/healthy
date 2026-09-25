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
 *   { items, total, matched, warnings, truncated, generatedAt }
 *   (+ coverage, on a call that named the resource types it covers; + raw, when
 *   asked for)
 *
 * The order of operations is fixed too: policy, then the tool's own `reshape`
 * (if it has one), then the caller's `jq` program, then the caller's `limit`.
 *
 *  - `total` is how many items the policy let through: the input to `jq`. A
 *    tool with a `reshape` defines it itself -- `get_conditions` reports the
 *    rows its filters kept, before `collapse` groups them, and adds `groups`
 *    (the number of groups, which is then the input to `jq`).
 *  - `matched` is the output count: how many values `jq` emitted, before
 *    `limit`. Without `jq` it is the number of items `limit` applies to --
 *    `total`, or `groups` after a collapse -- so the envelope has one shape
 *    whether or not a program ran.
 *  - `truncated` is decided AFTER filtering and `jq`, deliberately. Slicing to
 *    `limit` first would let a deny rule turn a full page into a short one and
 *    the caller would have no way to tell a filtered page from the end of the
 *    data.
 *
 * `limit` is optional and there is no default and no ceiling: an absent `limit`
 * means every matching item comes back, however many there are. `truncated` is
 * therefore only ever true when the caller passed a `limit` and it actually cut
 * something -- it is never how a tool quietly caps its own answer.
 *
 * `jq` sees only what the policy released: it runs on the filtered items, so a
 * denied field is not there to be selected, and a denied resource type or health
 * system is not in the array at all. `items` after `jq` is always the array of
 * every value the program emits, in order, even a single one -- so
 * `[.[] | select(...)]` (one output, itself an array) yields a one-element
 * `items` wrapping that array, not the filtered list; `.[] | select(...)` (a
 * stream, one output per match) is what gives one `items` element per match.
 * `limit` always applies to this array. With `raw: true` each input item also
 * carries its policy-filtered raw resource under `raw`, and the separate `raw`
 * array is not returned -- a program that filters or reshapes items would
 * otherwise leave it pointing at the wrong things.
 *
 * Errors are `isError` content carrying a stable code and a fixed sentence. Never
 * a stack, never an upstream body, never a resource: an upstream error message
 * from a health system can quote the record that caused it. The one exception is
 * a failing `jq` program, whose `detail` is jq's own message -- a model cannot fix
 * a filter it is not told the error in. That message can quote a value, but only
 * a value from the policy-filtered input the caller could have asked for without
 * `jq`, so it releases nothing new. It is never logged.
 */

import { toIso } from "../lib/time.ts";
import { applyPolicy, sortedWarnings } from "../policy/filter.ts";

import { INCOMPLETE_WARNING, coverageIncomplete, coverageWarnings } from "./coverage.ts";
import { runJq } from "./jq/engine.ts";

import type { CoverageEntry } from "./coverage.ts";
import type { JqFailureCode } from "./jq/engine.ts";
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
  | "internal_error"
  | JqFailureCode;

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
  ["not_connected", "that health system has no usable connection right now"],
  ["document_cap_reached", "daily document cap reached"],
  ["unsupported_document", "the document is not in a format this server can turn into text"],
  ["upstream_error", "the health system could not be reached or refused the request"],
  ["internal_error", "the request failed"],
  ["jq_error", "the jq program failed; `detail` has jq's message"],
  ["jq_budget_exceeded", "the jq program exceeded its step budget"],
  ["jq_out_of_memory", "the jq program exceeded its memory ceiling"],
]);

/** What `jq` did on one call, for the audit row. Counts only, never the program. */
export interface JqAudit {
  /** Items handed to the program. */
  inputCount: number;
  /** `matched`: how many values the program emitted. Null when it failed. */
  outputCount: number | null;
}

/** What a tool handler hands back, before the audit wrapper turns it into a result. */
export interface ToolOutcome {
  result: CallToolResult;
  /** Items actually returned, for the audit row. */
  resultCount: number;
  /** Health system ids the call read from, for the audit row. Ids, never names. */
  healthSystemIds: string[];
  /** Null on success; the stable code otherwise. */
  errorCode: ToolErrorCode | null;
  /** Present when a `jq` program ran (or was attempted). */
  jq?: JqAudit | undefined;
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
  options: { healthSystemIds?: string[]; detail?: string; jq?: JqAudit } = {},
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
    healthSystemIds: options.healthSystemIds ?? [],
    errorCode: code,
    ...(options.jq !== undefined && { jq: options.jq }),
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
  /**
   * The raw FHIR behind `items`, in the same order, whether or not it was
   * requested: the policy judges rendered reference names by it. Never returned.
   */
  sources?: readonly (RawEntry | undefined)[] | undefined;
  /** Omitted (or undefined) means no limit: every matching item is returned. */
  limit?: number | undefined;
  /** The caller's jq program, run after the policy and before `limit`. */
  jq?: string | undefined;
  /** Health system ids read from, for the audit row. */
  healthSystemIds: string[];
  /** Notes the tool itself wants to pass on (cache staleness, sync warnings). */
  warnings?: readonly string[] | undefined;
  /**
   * Per (health system, resource type) freshness for every type this tool
   * covers, from `collect()` or built directly with `worker/mcp/coverage.ts`.
   * Omitted only by the tools that read no resource type at all
   * (`get_document_text`, `list_health_systems`). When `items` comes back empty
   * and any entry here is not `ok` (or `unsupported`, which is not a gap), the
   * envelope gets {@link INCOMPLETE_WARNING} so an empty answer is never
   * mistaken for "nothing exists".
   */
  coverage?: readonly CoverageEntry[] | undefined;
  /**
   * A tool's own step between the policy and `jq`: filter or group the
   * policy-filtered items. It sees only what the policy released, so nothing it
   * derives (a count, a date range, a group) can carry a withheld value.
   */
  reshape?: ((rows: readonly ReshapeRow[]) => Reshaped) | undefined;
  /** Unix seconds. */
  now: number;
}

/** One policy-filtered item, and its policy-filtered raw resource when `raw` was asked for. */
export interface ReshapeRow {
  item: unknown;
  raw: RawEntry | undefined;
}

/** What a `reshape` hands back. */
export interface Reshaped {
  /** The items `jq` and `limit` now run on. */
  items: unknown[];
  /**
   * Index-aligned with `items`: what `raw` carries for each one (a raw entry,
   * or an array of them for an item made from several rows). Ignored unless
   * `raw` was asked for.
   */
  raw: unknown[];
  /** The envelope's `total`: the reshape documents what it counts. */
  total: number;
  /** Extra warnings: stable strings and counts, never a value from the record. */
  warnings: string[];
  /** Extra numeric envelope fields (`groups`). */
  envelope?: Record<string, number> | undefined;
}

/** The warning `jq` can add. A stable string, like every other warning. */
const JQ_RESULT_EMPTY = "jq_result_empty";

/** A program that turned a non-empty input into nothing: worth a second look. No outputs at all
 *  (`outputs` is empty) counts too -- `every` on an empty array is vacuously true. */
function looksEmpty(outputs: readonly unknown[]): boolean {
  return outputs.every((element) => element === null);
}

/** Item plus its raw resource, for a `jq` run with `raw: true`. */
function withRaw(items: readonly unknown[], rawItems: readonly unknown[]): unknown[] {
  return items.map((item, index) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? { ...item, raw: rawItems[index] ?? null }
      : item,
  );
}

interface Shaped {
  items: readonly unknown[];
  matched: number;
  truncated: boolean;
  /** Items returned after `limit`, for the audit row. */
  returned: number;
}

/** Apply `limit` to the array that is about to become `items`. */
function applyLimit(value: readonly unknown[], limit: number | undefined): Shaped {
  const kept = limit === undefined ? value : value.slice(0, limit);
  return {
    items: kept,
    matched: value.length,
    truncated: kept.length < value.length,
    returned: kept.length,
  };
}

/**
 * The tool's `reshape` over the policy's output, or that output unchanged.
 *
 * What a reshape builds (a collapsed condition's `firstSeen`, `occurrences`)
 * is a shape of its own, and the owner can write a rule against it; so the
 * policy runs over the reshaped items once more. Everything they carry came
 * from rows the first pass already filtered, so the second pass can only
 * remove more. It never drops an item -- tool, health-system and resource
 * rules already dropped the rows -- which keeps `raw` aligned.
 */
function reshapeFiltered(
  input: RespondInput,
  filtered: { items: unknown[]; rawItems: RawEntry[] },
  wantsRaw: boolean,
): Reshaped {
  const { reshape } = input;
  if (reshape === undefined) {
    return {
      items: filtered.items,
      raw: filtered.rawItems,
      total: filtered.items.length,
      warnings: [],
    };
  }
  const reshaped = reshape(
    filtered.items.map((item, index) => ({
      item,
      raw: wantsRaw ? filtered.rawItems[index] : undefined,
    })),
  );
  const again = applyPolicy({ tool: input.tool, items: reshaped.items, rules: input.rules });
  if (again.items.length !== reshaped.items.length) {
    // Unreachable (see above); failing closed rather than misaligning `raw`.
    return { items: [], raw: [], total: 0, warnings: again.warnings };
  }
  return {
    ...reshaped,
    items: again.items,
    warnings: [...reshaped.warnings, ...again.warnings],
  };
}

/**
 * Filter, run the caller's jq, page, serialise.
 *
 * `items` and `rawItems` stay index-aligned through the filter: both are judged
 * by the same resource-type and health system rules, so an item and the raw resource
 * behind it are always dropped together.
 */
export async function respond(input: RespondInput): Promise<ToolOutcome> {
  const filtered = applyPolicy({
    tool: input.tool,
    items: input.items,
    rawItems: input.rawItems,
    sources: input.sources,
    rules: input.rules,
  });

  if (filtered.denied) {
    return toolError("policy_denied", { healthSystemIds: input.healthSystemIds });
  }

  const limit = input.limit === undefined ? undefined : Math.max(0, Math.trunc(input.limit));
  const wantsRaw = input.rawItems !== undefined;
  const reshaped = reshapeFiltered(input, filtered, wantsRaw);
  const { items, raw: rawItems, total } = reshaped;
  const envelope = reshaped.envelope ?? {};
  // Checked on `total` -- post-policy, pre-`jq` -- so a denied pair (already
  // excluded from `coverage` itself) can never trigger this, and a `jq` program
  // narrowing a genuinely complete answer to nothing does not either.
  const incomplete =
    total === 0 && input.coverage !== undefined && coverageIncomplete(input.coverage);
  const baseWarnings = [
    ...(input.warnings ?? []),
    ...filtered.warnings,
    ...reshaped.warnings,
    ...(input.coverage === undefined ? [] : coverageWarnings(input.coverage)),
    ...(incomplete ? [INCOMPLETE_WARNING] : []),
  ];

  if (input.jq === undefined) {
    const shaped = applyLimit(items, limit);
    const payload: Record<string, unknown> = {
      items: shaped.items,
      total,
      ...envelope,
      matched: items.length,
      ...(input.coverage !== undefined && { coverage: input.coverage }),
      ...(wantsRaw && {
        raw: limit === undefined ? rawItems : rawItems.slice(0, limit),
      }),
      warnings: sortedWarnings(baseWarnings),
      truncated: shaped.truncated,
      generatedAt: toIso(input.now),
    };
    return {
      result: textResult(payload, false),
      resultCount: shaped.returned,
      healthSystemIds: input.healthSystemIds,
      errorCode: null,
    };
  }

  const jqInput = wantsRaw ? withRaw(items, rawItems) : items;
  const run = await runJq(input.jq, JSON.stringify(jqInput));
  if (!run.ok) {
    return toolError(run.code, {
      healthSystemIds: input.healthSystemIds,
      detail: run.message,
      jq: { inputCount: items.length, outputCount: null },
    });
  }

  // Every value the program emits becomes one element of `items`, even a
  // single one -- the caller chooses whether that is one match (a stream,
  // `.[] | select(...)`) or one shaped answer (a single non-array output).
  const shaped = applyLimit(run.outputs, limit);
  const empty = items.length > 0 && looksEmpty(run.outputs);
  const payload: Record<string, unknown> = {
    items: shaped.items,
    total,
    ...envelope,
    matched: shaped.matched,
    ...(input.coverage !== undefined && { coverage: input.coverage }),
    warnings: sortedWarnings([...baseWarnings, ...(empty ? [JQ_RESULT_EMPTY] : [])]),
    truncated: shaped.truncated,
    generatedAt: toIso(input.now),
  };
  return {
    result: textResult(payload, false),
    resultCount: shaped.returned,
    healthSystemIds: input.healthSystemIds,
    errorCode: null,
    jq: { inputCount: items.length, outputCount: shaped.matched },
  };
}
