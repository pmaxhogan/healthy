/**
 * Stable, non-Epic codes `fhir_sync_state` records, shared between the writer
 * and every reader.
 *
 * A leaf module on purpose, with no import of its own: `worker/sync/full-refresh.ts`
 * (the writer) and `worker/mcp/coverage.ts` (a reader, reached from nearly every
 * MCP tool through `collect.ts`) both need these two strings, and `full-refresh.ts`
 * pulls in D1, the Durable Object runners and the rest of the sync engine. A
 * reader importing them from there would drag that whole graph into a context
 * that does not have the Cloudflare Workers ambient types in scope --
 * `test/unit/**` in particular, which type-checks against plain Node.
 */

/**
 * `fhir_sync_state.last_error_code` for a registry search entry this
 * organisation's CapabilityStatement does not support (dropped by
 * `filterSupported`).
 *
 * Recorded rather than left as "no row at all" so the MCP coverage layer
 * (`worker/mcp/coverage.ts`) can tell "this organisation does not offer this
 * type" apart from "the daily refresh has not reached it yet" -- exactly the
 * distinction `worker/db/repos/fhir-sync-state.ts`'s own module comment says
 * this table exists to draw.
 */
export const UNSUPPORTED_ERROR_CODE = "unsupported";

/**
 * The prefix on a synthetic `SyncWarning.code` recorded when one parameter set
 * of a multi-set entry (a `byCategory` search) was rejected outright while at
 * least one other set of the same entry succeeded.
 *
 * Read by `worker/mcp/coverage.ts` to mark the pair `partial` rather than `ok`:
 * a category that came back empty because it does not apply is silence, but a
 * category Epic refused to run is not the same as "no care plans of that kind".
 */
export const CATEGORY_REJECTED_PREFIX = "category_rejected:";

/**
 * How much a code `fhir_sync_state` recorded matters to someone reading the
 * cache:
 *
 *  - `info`    -- expected; everything that could be returned was returned.
 *  - `warning` -- something was left out or deferred, and it may matter.
 *  - `error`   -- the resource type could not be read.
 *  - `unknown` -- a code this server has no documented meaning for.
 */
type SyncCodeSeverity = "info" | "warning" | "error" | "unknown";

export interface SyncCodeMeaning {
  meaning: string;
  severity: SyncCodeSeverity;
}

/**
 * What each code a sync can record means, for `get_sync_status` and `coverage`
 * to put next to the bare code. docs/mcp.md carries the same table, with its
 * sources.
 *
 * Epic's numeric codes come from `issue.details.coding[].code` on the
 * OperationOutcomes Epic interleaves with search results. The 41xx ones and
 * 59109 are the list `worker/fhir/operation-outcome.ts` classifies searches by;
 * 59204's wording follows Epic's own `details.text` for it, seen on a live
 * search ("Client not authorized for <Type> - Outside Record"). A code Epic has
 * not documented publicly and this server has not seen explained is left out on
 * purpose, so {@link explainSyncCode} calls it `unknown` rather than guessing.
 *
 * Only generic wording lives here. Epic's `diagnostics` text is never stored --
 * `fhir_sync_state.warnings` holds `{code, count}` alone -- because it can echo
 * the search's parameters.
 */
const MEANINGS: Readonly<Record<string, SyncCodeMeaning>> = {
  "4101": {
    meaning: "The search ran and matched nothing: there is no data of this kind to return.",
    severity: "info",
  },
  "4113": {
    meaning:
      "Epic's paged-search session expired part-way through; the refresh restarts the search once.",
    severity: "warning",
  },
  "4118": {
    meaning:
      "The health system refused this app access to this data for this patient; none of it was read.",
    severity: "error",
  },
  "4119": {
    meaning:
      "Epic's patient-facing view withheld some results under the health system's own " +
      "release rules (what its patient portal would not show either); everything else " +
      "was returned. Expected on almost every search.",
    severity: "info",
  },
  "4122": {
    meaning: "The health system did not recognise one search parameter and ignored it.",
    severity: "info",
  },
  "4135": {
    meaning:
      "The health system's daily document-download cap was reached; the remaining " +
      "documents are fetched on a later day.",
    severity: "warning",
  },
  "59109": {
    meaning: "An optional search parameter was invalid and was ignored.",
    severity: "info",
  },
  "59204": {
    meaning:
      "This app is not authorized for Epic's 'Outside Record' variant of this type " +
      "(records other organisations shared with this health system). The health " +
      "system's own records were returned; those outside copies are not.",
    severity: "info",
  },
  [UNSUPPORTED_ERROR_CODE]: {
    meaning:
      "The health system's FHIR server does not offer this resource type to patient " +
      "apps, so it is never searched. Harmless.",
    severity: "info",
  },
  upstream_auth: {
    meaning:
      "The health system rejected the access token or its scopes; the connection may need reconnecting.",
    severity: "error",
  },
  upstream_unavailable: {
    meaning: "The health system was unavailable after retries; the next refresh tries again.",
    severity: "error",
  },
  upstream_error: {
    meaning: "The health system rejected the search; the next refresh tries again.",
    severity: "error",
  },
  needs_reauth: {
    meaning: "The health system's sign-in has expired; the owner has to reconnect it.",
    severity: "error",
  },
  internal: {
    meaning: "This server failed while reading the type; the next refresh tries again.",
    severity: "error",
  },
};

/** The meaning of a code with none on record: said so, never guessed. */
const UNKNOWN: SyncCodeMeaning = {
  meaning: "No documented meaning for this code.",
  severity: "unknown",
};

function lookup(code: string): SyncCodeMeaning | undefined {
  return Object.hasOwn(MEANINGS, code) ? MEANINGS[code] : undefined;
}

/**
 * What one recorded code means.
 *
 * Takes a warning code (`"4119"`, `"category_rejected:encounter"`) or a
 * `last_error_code` (`"unsupported"`, `"upstream_error:4118"`). An error code
 * with an Epic suffix is explained by the suffix, which is the part that says
 * what happened, but is never reported as less than an `error`: whatever the
 * suffix, that type failed to sync.
 */
export function explainSyncCode(code: string): SyncCodeMeaning {
  if (code.startsWith(CATEGORY_REJECTED_PREFIX)) {
    return {
      meaning:
        `The health system refused the "${code.slice(CATEGORY_REJECTED_PREFIX.length)}" ` +
        "category of this search while the others succeeded, so that category is missing.",
      severity: "warning",
    };
  }
  const own = lookup(code);
  if (own !== undefined) return own;
  const colon = code.indexOf(":");
  if (colon > 0) {
    const detail = lookup(code.slice(colon + 1));
    if (detail !== undefined) return { meaning: detail.meaning, severity: "error" };
    const failure = lookup(code.slice(0, colon));
    if (failure !== undefined) return failure;
  }
  return UNKNOWN;
}

/** One recorded `{code, count}` warning row, with what the code means beside it. */
export interface ExplainedSyncWarning extends SyncCodeMeaning {
  code: string;
  count: number;
}

/** Every warning row of one `fhir_sync_state` entry, explained. Order kept. */
export function explainSyncWarnings(
  warnings: readonly { code: string; count: number }[],
): ExplainedSyncWarning[] {
  return warnings.map((warning) => ({
    code: warning.code,
    count: warning.count,
    ...explainSyncCode(warning.code),
  }));
}
