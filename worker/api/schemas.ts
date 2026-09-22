/**
 * Request-body and query schemas for the admin API.
 *
 * Every schema is strict: an unknown key is a rejected request, not a silently
 * dropped one. The admin UI and the Worker ship together, so a key the Worker does
 * not know is a bug in one of them and saying so is cheaper than debugging a
 * setting that appeared to save and did not.
 *
 * Kept free of Worker runtime types and of the db layer, so the unit tests can
 * import it directly.
 */

import { z } from "zod";

import { isHttpsUrl } from "@shared/url.ts";

import type { SetProviderSecretRequest } from "@shared/types.ts";

// Re-exported so `test/unit/api/schemas.test.ts` -- and anything else that
// already imports the predicate from here -- keeps working. The definition
// itself lives in shared/url.ts because the SPA needs the exact same rule.
export { isHttpsUrl } from "@shared/url.ts";

/** Matches an offset like `+05:00`, which Intl accepts but which is not a zone. */
const OFFSET_ZONE = /^[+-]/;

/**
 * Whether a string names an IANA time zone.
 *
 * `Intl.supportedValuesOf("timeZone")` is the exact answer where it exists, but it
 * lists canonical names only -- a legitimate alias (`US/Central`) is absent from
 * it -- so a miss falls through to the constructor, which accepts aliases and
 * throws a RangeError on anything it does not know.
 *
 * Fixed offsets are refused outright. `+05:00` would format, but it does not
 * follow daylight saving, and the sync's local-day window would be an hour wrong
 * for half the year.
 */
export function isValidTimezone(zone: string): boolean {
  if (zone === "" || OFFSET_ZONE.test(zone)) return false;
  const supported: ((key: "timeZone") => string[]) | undefined = Intl.supportedValuesOf;
  if (typeof supported === "function" && supported("timeZone").includes(zone)) return true;
  try {
    // The call, not just the constructor: some engines defer validation until the
    // format is actually used.
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
}

const httpsUrl = z.string().min(1).max(2048).refine(isHttpsUrl, { error: "must be an https URL" });

const timezone = z
  .string()
  .min(1)
  .max(100)
  .refine(isValidTimezone, { error: "must be an IANA time zone" });

const shortText = z.string().min(1).max(200);

/** A Google `colorId`: the palette is keyed "1".."11", but the list is Google's. */
const colorId = z.string().min(1).max(8);

const offsetMinutes = z.number().int().min(0).max(1440);

/** The camelCase per-provider config the SPA sends. */
const providerConfigSchema = z.strictObject({
  titleTemplate: z.string().min(1).max(300).optional(),
  colorId: colorId.optional(),
  arrivalOffsetMin: offsetMinutes.optional(),
  arrivalOffsetsByVisitType: z.record(z.string().min(1).max(200), offsetMinutes).optional(),
  orgShort: z.string().min(1).max(60).optional(),
  enabled: z.boolean().optional(),
});

/**
 * `POST /api/providers`.
 *
 * Either a `brandId` from `/api/brands` or a manual `fhirBaseUrl`; the handler
 * requires exactly one, because "both" would leave it guessing which the owner
 * meant when they disagree.
 */
export const providerCreateSchema = z.strictObject({
  displayName: shortText,
  brandId: z.string().min(1).max(200).optional(),
  fhirBaseUrl: httpsUrl.optional(),
  portalUrl: httpsUrl.optional(),
  environment: z.enum(["prod", "sandbox"]),
  clientSecret: z.string().min(1).max(1000).optional(),
  config: providerConfigSchema.optional(),
});

/** `PATCH /api/providers/:id`. The FHIR base is not editable; delete and re-add. */
export const updateProviderSchema = z.strictObject({
  displayName: shortText.optional(),
  portalUrl: httpsUrl.nullable().optional(),
  config: providerConfigSchema.optional(),
});

/**
 * `POST /api/providers/:id/secret`.
 *
 * Annotated with the shared request DTO rather than just inferring: that is what
 * makes a change to `SetProviderSecretRequest` a compile error here instead of a
 * schema that quietly stops matching what the SPA sends.
 */
export const providerSecretSchema: z.ZodType<SetProviderSecretRequest> = z.strictObject({
  clientSecret: z.string().min(1).max(1000),
});

/**
 * `PUT /api/settings`.
 *
 * `syncBackoffUntil` is accepted so the SPA can round-trip the DTO it was given,
 * and is then ignored -- see `fromSettingsPatch`.
 */
export const settingsPatchSchema = z.strictObject({
  timezone: timezone.nullable().optional(),
  calendarId: shortText.optional(),
  defaultTitleTemplate: z.string().min(1).max(300).optional(),
  defaultColorId: colorId.nullable().optional(),
  ghostColorId: colorId.optional(),
  defaultArrivalOffsetMin: offsetMinutes.optional(),
  windowPastDays: z.number().int().min(0).max(3650).optional(),
  syncBackoffUntil: z.string().nullable().optional(),
  mcpEnabled: z.boolean().optional(),
});

/** `POST /api/mcp/policy`. */
export const policyRuleSchema = z.strictObject({
  ruleType: z.enum(["tool", "resource", "field", "provider"]),
  target: z.string().min(1).max(200),
  note: z.string().max(500).optional(),
});

/** `POST /api/sync/run` and `POST /api/providers/:id/full-refresh`. */
export const syncRequestSchema = z.strictObject({
  providerIds: z.array(z.string().min(1).max(64)).max(50).optional(),
});

/** `GET /api/brands?q=`. */
export const brandQuerySchema = z.object({
  q: z.string().max(200).optional(),
});
