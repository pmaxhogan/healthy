/**
 * OperationOutcome parsing and classification.
 *
 * Epic reports most search problems two ways at once: a FHIR `issue.code` and
 * `issue.severity` from the standard value sets, and its own numeric code buried
 * in `issue.details.coding[].code`. The numeric code is the one that says what
 * actually happened, so it is what this module keys off.
 *
 * The numeric codes that matter here (all confirmed against Epic's published
 * error list):
 *
 *   4101   no results for the search           -> not an error, empty result
 *   4113   paged search session expired        -> restart the search once
 *   4118   user not authorized for this data   -> upstream_auth, do not retry
 *   4119   patient-facing view filtered results-> warning, results are partial
 *   4122   unknown search parameter            -> warning, parameter ignored
 *   4135   daily document-query cap reached    -> stop pulling Binary today
 *   59109  optional parameter invalid          -> warning, parameter ignored
 *
 * `severity` is not a reliable discriminator on its own: Epic has been observed
 * sending 4101 as `information`, `warning` and `error` depending on version, so
 * `classifyOutcome` checks the numeric code before it looks at severity.
 */

import { isRecord } from "./bundle.ts";

import type { OperationOutcome, OperationOutcomeIssue, SearchWarning } from "./types.ts";

export const EPIC_NO_RESULTS = "4101";
export const EPIC_PAGING_EXPIRED = "4113";
export const EPIC_NOT_AUTHORIZED = "4118";
export const EPIC_FILTERED_VIEW = "4119";
export const EPIC_UNKNOWN_PARAM = "4122";
export const EPIC_DOCUMENT_CAP = "4135";
export const EPIC_OPTIONAL_PARAM_INVALID = "59109";

/**
 * Codes that arrive with an error-ish severity but are not failures: the search
 * succeeded, it just has nothing or less than everything to say.
 */
const BENIGN_EPIC_CODES: ReadonlySet<string> = new Set([
  EPIC_NO_RESULTS,
  EPIC_FILTERED_VIEW,
  EPIC_UNKNOWN_PARAM,
  EPIC_OPTIONAL_PARAM_INVALID,
]);

/** One issue, flattened. `epicCode` is null when the outcome is not Epic's. */
export interface ParsedIssue {
  severity: string;
  code: string;
  diagnostics: string | null;
  epicCode: string | null;
  detailsText: string | null;
}

/** True when the parsed body is a FHIR OperationOutcome. */
export function isOperationOutcome(value: unknown): value is OperationOutcome {
  return isRecord(value) && value.resourceType === "OperationOutcome";
}

function epicCodeOf(issue: OperationOutcomeIssue): string | null {
  const coding = Array.isArray(issue.details?.coding) ? issue.details.coding : [];
  let fallback: string | null = null;
  for (const entry of coding) {
    const code = typeof entry.code === "string" ? entry.code : null;
    if (code === null || code === "") continue;
    if (/^\d+$/u.test(code)) return code;
    fallback ??= code;
  }
  return fallback;
}

function parseIssue(issue: unknown): ParsedIssue | null {
  if (!isRecord(issue)) return null;
  // A partial cast: the fields below are all re-checked before they are read, so
  // this only borrows the shape, it does not trust it.
  const typed = issue as unknown as OperationOutcomeIssue;
  return {
    severity: typeof typed.severity === "string" ? typed.severity : "unknown",
    code: typeof typed.code === "string" ? typed.code : "unknown",
    diagnostics: typeof typed.diagnostics === "string" ? typed.diagnostics : null,
    epicCode: epicCodeOf(typed),
    detailsText: typeof typed.details?.text === "string" ? typed.details.text : null,
  };
}

/**
 * Every issue in an OperationOutcome, flattened.
 *
 * Takes `unknown` so callers can hand it a parsed response body or the resource
 * out of a `search.mode === "outcome"` entry without checking first; anything
 * that is not an OperationOutcome yields an empty list.
 */
export function parseIssues(value: unknown): ParsedIssue[] {
  if (!isOperationOutcome(value)) return [];
  const raw: unknown = value.issue;
  const issues = Array.isArray(raw) ? raw : [];
  const out: ParsedIssue[] = [];
  for (const issue of issues) {
    const parsed = parseIssue(issue);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

/** What a set of issues means for the search that produced them. */
export interface OutcomeClass {
  /** Epic 4101: the search ran and matched nothing. Not an error. */
  noResults: boolean;
  /** Epic 4119: the patient-facing view withheld some results. */
  filtered: boolean;
  /** Epic 4113: the paging session expired. Restart from the first page, once. */
  pagingExpired: boolean;
  /** Epic 4118: this user may not see this data. Never retried. */
  notAuthorized: boolean;
  /** Epic 4135: the organisation's daily document-query cap is reached. */
  documentCapReached: boolean;
  /**
   * An error or fatal issue that is none of the benign codes above.
   *
   * `pagingExpired` and `notAuthorized` also set this: they are real failures,
   * they just have a specific recovery. Check them first.
   */
  fatal: boolean;
  /** Every numeric Epic code seen, in order, for logging. */
  codes: string[];
}

export function classifyOutcome(issues: readonly ParsedIssue[]): OutcomeClass {
  const codes: string[] = [];
  let fatal = false;
  for (const issue of issues) {
    if (issue.epicCode !== null) codes.push(issue.epicCode);
    const severe = issue.severity === "fatal" || issue.severity === "error";
    const benign = issue.epicCode !== null && BENIGN_EPIC_CODES.has(issue.epicCode);
    if (severe && !benign) fatal = true;
  }
  return {
    noResults: codes.includes(EPIC_NO_RESULTS),
    filtered: codes.includes(EPIC_FILTERED_VIEW),
    pagingExpired: codes.includes(EPIC_PAGING_EXPIRED),
    notAuthorized: codes.includes(EPIC_NOT_AUTHORIZED),
    documentCapReached: codes.includes(EPIC_DOCUMENT_CAP),
    fatal,
    codes,
  };
}

/** Flatten issues into the storable/loggable warning rows a search returns. */
export function toSearchWarnings(
  resourceType: string,
  issues: readonly ParsedIssue[],
): SearchWarning[] {
  return issues.map((issue) => ({
    resourceType,
    severity: issue.severity,
    code: issue.code,
    epicCode: issue.epicCode,
    diagnostics: issue.diagnostics,
  }));
}
