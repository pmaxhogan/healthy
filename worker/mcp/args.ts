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

import { MAX_LIMIT } from "./deps.ts";

/** An ISO-8601 date (`2026-01-31`) or instant (`2026-01-31T09:00:00Z`). */
const instant = z
  .string()
  .min(4)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "must be an ISO-8601 date or instant",
  });

/**
 * The three arguments every tool takes.
 *
 * `providers` accepts either a provider id (as `list_providers` reports it) or a
 * case-insensitive substring of a display name, because a model that has just
 * read "Example Health" will try to pass that back.
 */
const SHARED_ARGS = {
  providers: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .describe("Provider ids, or case-insensitive substrings of provider display names."),
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
    .max(MAX_LIMIT)
    .optional()
    .describe(`Maximum items to return. Default 50, maximum ${String(MAX_LIMIT)}.`),
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
  providers?: string[] | undefined;
  raw?: boolean | undefined;
  limit?: number | undefined;
}

/** A window, for the tools that take one. */
export interface WindowArgs {
  from?: string | undefined;
  to?: string | undefined;
}
