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

import type {
  PortalDiscoverRequest,
  PutPortalAccountRequest,
  SetHealthSystemSecretRequest,
} from "@shared/types.ts";

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

/**
 * A sender domain: at least two labels, and nothing but a domain.
 *
 * Validated rather than free text because the matching rule is anchored now
 * (`domainAllowed` in `worker/mail/classify.ts`), and a stored entry that is not
 * domain-shaped is one nothing will ever match -- a silent "no mail is ever
 * accepted" rather than a rejected save. It also closes the older failure in the
 * other direction: with containment matching, a one-character entry like `"e"`
 * allowlisted most of the internet, silently.
 *
 * Case-insensitive: entries are lower-cased on the way to storage, by
 * `formatAllowlistCsv`.
 */
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const MAX_DOMAIN_CHARS = 253;
const MAX_LABEL_CHARS = 63;

/**
 * Whether `value`, trimmed, is a domain with at least two labels.
 *
 * Split-then-check-each-label rather than one regex for the whole domain: the
 * obvious single pattern nests a quantified label group inside a quantified
 * `(\.label)+`, which is exactly the shape that backtracks super-linearly on a
 * near-miss. `DOMAIN_LABEL` has one unnested `*` between two anchors, so it is
 * linear in the label, and the label count is bounded by the length cap above.
 */
function isSenderDomain(value: string): boolean {
  const entry = value.trim();
  if (entry.length === 0 || entry.length > MAX_DOMAIN_CHARS) return false;
  const labels = entry.split(".");
  return (
    labels.length >= 2 &&
    labels.every(
      (label) => label.length > 0 && label.length <= MAX_LABEL_CHARS && DOMAIN_LABEL.test(label),
    )
  );
}

const senderDomain = z
  .string()
  .min(3)
  .max(253)
  .refine(isSenderDomain, { error: "must be a domain with at least two labels" });

const shortText = z.string().min(1).max(200);

/** A Google `colorId`: the palette is keyed "1".."11", but the list is Google's. */
const colorId = z.string().min(1).max(8);

const offsetMinutes = z.number().int().min(0).max(1440);

/** The camelCase per-health system config the SPA sends. */
const healthSystemConfigSchema = z.strictObject({
  titleTemplate: z.string().min(1).max(300).optional(),
  colorId: colorId.optional(),
  arrivalOffsetMin: offsetMinutes.optional(),
  arrivalOffsetsByVisitType: z.record(z.string().min(1).max(200), offsetMinutes).optional(),
  orgShort: z.string().min(1).max(60).optional(),
  enabled: z.boolean().optional(),
});

/**
 * `POST /api/health-systems`.
 *
 * Either a `brandId` from `/api/brands` or a manual `fhirBaseUrl`; the handler
 * requires exactly one, because "both" would leave it guessing which the owner
 * meant when they disagree.
 */
export const healthSystemCreateSchema = z.strictObject({
  displayName: shortText,
  brandId: z.string().min(1).max(200).optional(),
  fhirBaseUrl: httpsUrl.optional(),
  portalUrl: httpsUrl.optional(),
  environment: z.enum(["prod", "sandbox"]),
  clientSecret: z.string().min(1).max(1000).optional(),
  config: healthSystemConfigSchema.optional(),
});

/** `PATCH /api/health-systems/:id`. The FHIR base is not editable; delete and re-add. */
export const updateHealthSystemSchema = z.strictObject({
  displayName: shortText.optional(),
  portalUrl: httpsUrl.nullable().optional(),
  config: healthSystemConfigSchema.optional(),
});

/**
 * `POST /api/health-systems/:id/secret`.
 *
 * Annotated with the shared request DTO rather than just inferring: that is what
 * makes a change to `SetHealthSystemSecretRequest` a compile error here instead of a
 * schema that quietly stops matching what the SPA sends.
 */
export const healthSystemSecretSchema: z.ZodType<SetHealthSystemSecretRequest> = z.strictObject({
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
  portalLoginAttemptLimit: z.number().int().min(1).max(20).optional(),
});

/** `POST /api/mcp/policy`. */
export const policyRuleSchema = z.strictObject({
  ruleType: z.enum(["tool", "resource", "field", "health_system"]),
  target: z.string().min(1).max(200),
  note: z.string().max(500).optional(),
});

/**
 * `POST /api/mcp/tools/:name/call`.
 *
 * Not strict, and not shaped to any one tool: the real shape is a different zod
 * object per tool, enforced by the MCP server itself when the call reaches it
 * (`worker/mcp/admin-call.ts`). All this schema does is what the JSON body has to
 * be before that check is even possible -- a plain object, not an array, a string
 * or a bare number.
 */
export const mcpToolCallArgsSchema = z.record(z.string(), z.unknown());

/** `POST /api/sync/run` and `POST /api/health-systems/:id/full-refresh`. */
export const syncRequestSchema = z.strictObject({
  healthSystemIds: z.array(z.string().min(1).max(64)).max(50).optional(),
});

/** `GET /api/brands?q=`. */
export const brandQuerySchema = z.object({
  q: z.string().max(200).optional(),
});

/**
 * `PUT /api/health-systems/:id/portal`.
 *
 * Annotated with the shared request DTO, like `healthSystemSecretSchema`: that is what
 * makes a change to `PutPortalAccountRequest` a compile error here rather than a
 * body the SPA sends and the Worker silently rejects.
 *
 * `mountHint` is a hint, not a path: discovery probes it first and then the generic
 * prefixes, and what gets stored is wherever a login page actually answered. It is
 * bounded and otherwise unvalidated, because the shape of a vanity mount is the
 * deployment's business.
 */
export const portalAccountSchema: z.ZodType<PutPortalAccountRequest> = z.strictObject({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(1000),
  baseUrl: httpsUrl.optional(),
  mountHint: z.string().min(1).max(200).optional(),
  mfaContact: z.email().max(320).optional(),
  otpSenderDomain: senderDomain.optional(),
  // Required, and an https URL like `baseUrl`: the handler keeps its origin and
  // refuses to seal a credential unless discovery lands on exactly that.
  confirmedOrigin: httpsUrl,
});

/** `POST /api/health-systems/:id/portal/discover`. Probe only -- nothing is stored. */
export const portalDiscoverSchema: z.ZodType<PortalDiscoverRequest> = z.strictObject({
  baseUrl: httpsUrl,
  mountHint: z.string().min(1).max(200).optional(),
});

/** `PUT /api/mail/settings`. Replaces the whole allowlist -- there is only one field. */
export const mailAllowlistSchema = z.strictObject({
  allowlist: z.array(senderDomain).min(1).max(50),
});
