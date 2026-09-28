/**
 * The argument schemas every tool shares.
 *
 * All strict: `z.strictObject` rejects an unknown key rather than ignoring it.
 * That matters more here than it usually does, because the caller is a language
 * model. A model that invents `patient: "me"` or misspells `from` as `since`
 * should be told, not quietly served the unfiltered list -- silently ignoring an
 * argument is how a filter the caller believed in stops existing.
 */

import { z } from "zod";

import { JQ_EXAMPLES } from "./jq-examples.ts";
import { isIsoDateOrInstant } from "./window.ts";

import type { ToolName } from "./tool-names.ts";

/** The longest jq program accepted, in characters. A bound on the program, not the data. */
const JQ_MAX_LENGTH = 4096;

/**
 * An ISO-8601 date or instant, at any precision a caller is likely to write:
 * `2026`, `2026-01`, `2026-01-31`, `2026-01-31T09:00`, `2026-01-31T09:00:00Z`,
 * `2026-01-31T09:00:00.000+02:00`. Anything else is rejected rather than
 * guessed at; `worker/mcp/window.ts` has the rules and what each form bounds.
 */
const instant = z.string().refine(isIsoDateOrInstant, {
  message: "must be an ISO-8601 date (2026-01-31, 2026-01, 2026) or instant",
});

/**
 * What every tool's `jq` description says before that tool's own examples.
 * One sentence: `MCP_INSTRUCTIONS` (worker/mcp/instructions.ts) explains the
 * rest once for every tool.
 */
const JQ_SEMANTICS =
  "Optional jq program (jq 1.8) run server-side on the `items` array, after the " +
  "owner's exposure policy and before `limit`; each value it emits becomes one item, " +
  "so stream with `.[] | ...` rather than wrapping the result in `[...]`. With " +
  "`raw: true` each item carries its FHIR resource under `.raw`.";

function jqSchema(description: string) {
  return z.string().min(1).max(JQ_MAX_LENGTH).optional().describe(description);
}

/**
 * The optional jq program, described with one tool's own examples from
 * `JQ_EXAMPLES` (worker/mcp/jq-examples.ts). Spread it into the tool's schema
 * shape -- `toolArgs({ ...jqArg("get_x"), ... })`, or into a strict object of
 * the tool's own -- and it replaces the generic description `toolArgs` starts
 * from.
 *
 * It runs in `respond()` (worker/mcp/respond.ts) on data the exposure policy
 * has already filtered, and before `limit`. The length ceiling bounds the
 * caller's program, not any data; worker/mcp/jq/engine.ts has the other bounds.
 */
export function jqArg(tool: ToolName) {
  const examples = JQ_EXAMPLES[tool].map((example) => `\`${example}\``).join("; ");
  return { jq: jqSchema(`${JQ_SEMANTICS} Examples for this tool: ${examples}.`) } as const;
}

/**
 * The generic `jq` argument, for a schema built with `toolArgs` that has not
 * spread its tool's {@link jqArg} over it. Every registered tool does; a test
 * holds them to it.
 */
const JQ_ARGS = {
  jq: jqSchema(`${JQ_SEMANTICS} Example: \`.[] | select(.date >= "2026-01-01")\`.`),
} as const;

/**
 * The arguments every tool takes.
 *
 * `health_systems` accepts either a health system id (as `list_health_systems` reports it) or a
 * case-insensitive substring of a display name, because a model that has just
 * read "Example Health" will try to pass that back.
 */
const SHARED_ARGS = {
  healthSystems: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .describe("Health system ids, or case-insensitive substrings of health system display names."),
  raw: z
    .boolean()
    .optional()
    .describe(
      "Also return the underlying FHIR resources, as the organisation sent them, " +
        "minus the owner's exposure policy and the sensitive-field default. Use it " +
        "only when a normalized item is missing something you need: the raw " +
        "resource carries fields normalization deliberately leaves out.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Maximum items to return. There is no default and no maximum: omit this " +
        "to get every matching item, however many there are. The response's " +
        "`total` says how many matched and `truncated` says whether this limit " +
        "cut any off.",
    ),
  ...JQ_ARGS,
} as const;

/**
 * A date window, on the tools that have one, saying which of the item's fields
 * it compares -- `field` is how that tool's description names it, e.g.
 * "`start`" or "`effective` (else `issued`)".
 *
 * The rules, which `worker/mcp/window.ts` and `collect.ts`'s `inWindow` implement
 * and docs/mcp.md repeats: both ends inclusive; a value without a time is a
 * whole UTC period (`to: "2026-01-31"` runs to the end of that UTC day, `to:
 * "2026-01"` to the end of January, `from` starts at the period's first
 * instant); a time without an offset is UTC; an item missing the field falls
 * back to when the health system last updated it, and an item with no usable
 * date at all is left out of any windowed call.
 */
export function windowArgs(field: string) {
  return {
    from: instant
      .optional()
      .describe(
        `Only items whose ${field} is on or after this, inclusive. A date ` +
          "(`2026-01-31`, `2026-01`, `2026`) starts at the first instant of that UTC " +
          "day, month or year; an instant (`2026-01-31T09:00:00Z`) is exact, and one " +
          "without an offset is UTC.",
      ),
    to: instant
      .optional()
      .describe(
        `Only items whose ${field} is on or before this, inclusive. A date runs through ` +
          "the end of that UTC day, month or year (`2026-01-31` includes all of the 31st); " +
          "an instant without an offset is UTC. Pass `+HH:MM` to mean a local day.",
      ),
  } as const;
}

/**
 * Build a strict schema from the shared arguments plus a tool's own. The tool
 * spreads its {@link jqArg} into `shape` so its `jq` carries its own examples.
 */
export function toolArgs<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.strictObject({ ...SHARED_ARGS, ...shape });
}

/** The strict schema for a tool that takes nothing but the shared arguments. */
export function sharedOnlyArgs(tool: ToolName) {
  return z.strictObject({ ...SHARED_ARGS, ...jqArg(tool) });
}

/** What every tool receives, whatever else it declares. */
export interface SharedArgs {
  healthSystems?: string[] | undefined;
  raw?: boolean | undefined;
  limit?: number | undefined;
  jq?: string | undefined;
}

/** A window, for the tools that take one. */
export interface WindowArgs {
  from?: string | undefined;
  to?: string | undefined;
}
