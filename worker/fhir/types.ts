/**
 * The FHIR types this project uses, plus the handful of small shapes that are
 * ours rather than HL7's.
 *
 * Everything FHIR comes from `@types/fhir` (`fhir/r4`). Re-exporting the subset
 * we actually touch from one place means the rest of the Worker imports
 * `../fhir/types.ts` and never has to remember which of r4/r4b/r5 it wanted.
 *
 * Our own shapes deliberately use `T | null` rather than optional properties:
 * `exactOptionalPropertyTypes` is on, these values are round-tripped through
 * `JSON.stringify` into D1, and a missing key and an explicit null then behave
 * the same on the way back out.
 */

// Only the types something actually imports: knip fails the build on an export
// nothing uses, so this list grows as the code that needs it lands.
export type {
  Bundle,
  BundleEntry,
  CapabilityStatement,
  Encounter,
  OperationOutcome,
  OperationOutcomeIssue,
  Patient,
  Resource,
} from "fhir/r4";

/** Every vendor this build knows how to talk to. Epic only, for now. */
export type Vendor = "epic";

/**
 * The result of a successful token exchange or refresh.
 *
 * `expiresAt` is absolute epoch milliseconds, computed from the response's
 * `expires_in` against the injected clock: Epic's access-token lifetime is set
 * per organisation and has been observed anywhere from minutes to an hour, so
 * it is never assumed.
 *
 * `patientId` is the R4 Patient id from the token response's `patient` field --
 * the only patient id that is valid at that organisation.
 */
export interface TokenSet {
  accessToken: string;
  expiresAt: number;
  refreshToken: string | null;
  scope: string;
  patientId: string;
  idToken: string | null;
}

/**
 * The fields of `.well-known/smart-configuration` this project needs.
 *
 * Cached by the caller (7 days, per provider) -- nothing in here is fetched on
 * a hot path.
 */
export interface SmartConfig {
  authorizeUrl: string;
  tokenUrl: string;
  /** SMART `capabilities`, e.g. `launch-standalone`, `permission-v2`. */
  capabilities: string[];
  /** `code_challenge_methods_supported`. Epic advertises S256 only. */
  pkceMethods: string[];
  /** `token_endpoint_auth_methods_supported`, e.g. `client_secret_basic`. */
  tokenAuthMethods: string[];
}

/** What one resource type supports at one organisation. */
export interface CapabilityResource {
  /** FHIR interaction codes: `read`, `search-type`, `vread`, `history-instance`. */
  interactions: string[];
  /** Search parameter names the CapabilityStatement advertises. */
  searchParams: string[];
}

/**
 * A compact, JSON-serialisable index of one organisation's CapabilityStatement.
 *
 * Plain objects and arrays on purpose: wave 2 caches this per provider in D1,
 * and a Map or a Set would not survive the round trip.
 */
export interface CapabilityIndex {
  fhirVersion: string | null;
  resources: Record<string, CapabilityResource>;
}

/**
 * A non-fatal problem a search reported, flattened for storage and logging.
 *
 * Carries codes and severities only -- `diagnostics` is kept because Epic puts
 * useful operator detail there, but callers must not log it: at some
 * organisations it names the department that filtered a result.
 */
export interface SearchWarning {
  resourceType: string;
  severity: string;
  code: string;
  /** Epic's numeric code from `details.coding[].code`, e.g. `"4119"`. */
  epicCode: string | null;
  diagnostics: string | null;
}
