/**
The argument schemas the Health Connect tools share.

Strict, like every other tool's (`../args.ts` says why). They do not start
from `toolArgs`: `healthSystems` and `raw` mean nothing for phone data, and
an argument a tool accepts and ignores is a filter the caller only believed
in. A phone is chosen with `devices`.

Argument names are the ones the tool specification fixed (`max_bytes`,
`origin_mode`, `include_metadata`, ...); item fields stay lowerCamel like
every other item this server returns.
*/

import { z } from "zod";

import { jqArg } from "../args.ts";

import { DEFAULT_MAX_BYTES } from "./page.ts";
import { isDateOrOffsetInstant, isTimeZone } from "./time.ts";

import type { ToolName } from "../tool-names.ts";

const moment = z.string().refine(isDateOrOffsetInstant, {
  message:
    "must be a calendar date (2026-01-31) or an instant with its offset " +
    "(2026-01-31T09:00:00-05:00, 2026-01-31T14:00:00Z)",
});

const SHARED = {
  devices: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .describe(
      "Phones to read: device ids (`device:<id>`, as `coverage[].healthSystemId` gives " +
        "them) or case-insensitive substrings of a phone's name. Omit for every paired phone, " +
        "revoked ones included (revoking keeps the data): when rows come from more than one, " +
        "the answer warns `multiple_devices:<n>`, and naming one here is how to pick it.",
    ),
  tz: z
    .string()
    .min(1)
    .max(64)
    .refine(isTimeZone, { message: "must be an IANA time zone name" })
    .optional()
    .describe(
      "IANA time zone the answer is in: what a calendar date in `start`/`end` means, " +
        "where day, week and month buckets begin, and the offset every returned time " +
        "carries. Omit to use the owner's configured zone, which the answer names in `timeZone`.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Maximum rows in this answer. No default and no maximum. When it cuts rows off, " +
        "`truncated` is true and `cursor` continues from the next one.",
    ),
  max_bytes: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `Soft budget for the serialised \`items\`, in bytes (default ${String(DEFAULT_MAX_BYTES)}). ` +
        "The answer is cut at a row boundary once it is reached (never below one row), with " +
        "`truncated: true` and a `cursor`. There is no maximum: raise it to get more per " +
        "call, or shrink the rows with `jq`.",
    ),
  cursor: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .describe(
      "The `cursor` of a truncated answer, to continue it. Repeat that call exactly, " +
        "changing only `cursor` (and, if you like, `limit` or `max_bytes`).",
    ),
} as const;

/** The strict schema of a Health Connect tool: the shared arguments plus its own. */
export function hcArgs<Shape extends z.ZodRawShape>(tool: ToolName, shape: Shape) {
  return z.strictObject({ ...SHARED, ...jqArg(tool, "paged"), ...shape });
}

/**
A range of instants, half-open: `[start, end)`. `subject` is what the range
selects, for the description. An `end` given as a calendar date names the
whole of that local day, so the instant the range ends at is the NEXT
midnight: the date is included, the instant is not (`parseRange`).
*/
export function rangeArgs(subject: string) {
  return {
    start: moment.describe(
      `Start of the range (inclusive): ${subject}. A calendar date (\`2026-01-31\`) is the ` +
        "start of that local day in `tz`; an instant must carry its offset " +
        "(`2026-01-31T09:00:00-05:00`).",
    ),
    end: moment
      .optional()
      .describe(
        "End of the range. An instant (`2026-01-31T09:00:00-05:00`) is EXCLUSIVE: the " +
          "range stops just before it. A calendar date is INCLUSIVE: it means the whole of " +
          "that local day, so `start: 2026-01-30, end: 2026-01-31` is two days and the same " +
          "date in both is one day. Omit for now.",
      ),
  } as const;
}

/**
What a tool that takes a range says about `[start, end)` beside the
notation, which on its own reads as "the end is never included".
*/
export const RANGE_NOTE =
  "In `[start, end)` an `end` written as an instant is exclusive, and an `end` written " +
  "as a calendar date includes that whole local day (two dates a day apart are two days).";

/** What every Health Connect tool says about its answer's size. */
export const BUDGET_NOTE =
  "Rows are JSON with units declared once in `units`, not per row. The answer stops at " +
  `a soft budget of ${String(DEFAULT_MAX_BYTES)} bytes of rows, and it always says so: \`truncated: true\` ` +
  "plus a `cursor` to continue from; nothing is dropped. Raise `max_bytes` (no maximum) " +
  "or project with `jq` to get more per call. Whenever `truncated` is true the answer " +
  "is NOT the whole of what was asked: follow the `cursor` before concluding anything " +
  "from what is absent.";

/** What every Health Connect tool says about an empty answer. */
export const AVAILABILITY_NOTE =
  "`coverage` has one entry per phone and `hc:<Type>` that has stored records, and " +
  "`warnings` say when one is `stale` (the phone has not uploaded for six hours, so the " +
  "newest data may be missing). `freshness` says how current the answer is, per phone: " +
  "`lastUploadAt`, `hoursSinceUpload` (one decimal) and `dataThrough`, the end of the " +
  "newest stored record of each `hc:<Type>` in `coverage` -- the answer holds nothing " +
  "of that type after it. The phone uploads about every fifteen minutes; once its last " +
  "upload is more than an hour old the answer warns " +
  "`hc_upload_stale:device:<id>:<hours>h`, and whatever was measured since is missing: " +
  "say so, and do not read the gap as inactivity. A type with no stored records is " +
  "simply not listed; " +
  "asked for by name it answers empty with `no_data:hc:<Type>:device:<id>`, and a name " +
  "that is no record type answers `unknown_type:hc:<Type>`.";
