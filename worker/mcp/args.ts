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

/** The longest jq program accepted, in characters. A bound on the program, not the data. */
const JQ_MAX_LENGTH = 4096;

/** An ISO-8601 date (`2026-01-31`) or instant (`2026-01-31T09:00:00Z`). */
const instant = z
  .string()
  .min(4)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "must be an ISO-8601 date or instant",
  });

/**
 * The optional jq program every tool accepts -- including `get_document_text`,
 * which takes none of the other shared arguments.
 *
 * It runs in `respond()` (worker/mcp/respond.ts) on data the exposure policy has
 * already filtered, and before `limit`. The length ceiling bounds the caller's
 * program, not any data; worker/mcp/jq/engine.ts has the other bounds.
 */
export const JQ_ARGS = {
  jq: z
    .string()
    .min(1)
    .max(JQ_MAX_LENGTH)
    .optional()
    .describe(
      "Optional jq program (real jq 1.8), run server-side on the result before it is " +
        "returned. Its input is the `items` array; with `raw: true` each item also " +
        "carries its FHIR resource under `raw`. A single output becomes `items`; " +
        "several outputs are collected into an array. `limit` applies to the output. " +
        "ISO dates compare correctly as strings. Example: " +
        '`[.[] | select(.date >= "2026-01-01")]`.',
    ),
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

/** A date window, on the tools that have one. */
export const WINDOW_ARGS = {
  from: instant.optional().describe("Only items on or after this date."),
  to: instant.optional().describe("Only items on or before this date."),
} as const;

/** Build a strict schema from the shared arguments plus a tool's own. */
export function toolArgs<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.strictObject({ ...SHARED_ARGS, ...shape });
}

/** The strict schema for a tool that takes nothing but the shared arguments. */
export function sharedOnlyArgs() {
  return z.strictObject({ ...SHARED_ARGS });
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
