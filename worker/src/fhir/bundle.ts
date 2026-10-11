/**
 * Bundle accessors.
 *
 * Every function here takes `unknown` or a `Bundle` that may be missing any
 * optional field, because a real Epic response routinely is: `entry` is absent
 * on an empty search, `link` is absent on a single-page result, and an entry can
 * carry a `search.mode` of `outcome` with an OperationOutcome instead of a
 * matched resource.
 */

import type { Bundle, BundleEntry, Resource } from "./types.ts";

/** True for any non-null object. The starting point of every parse in here. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** True when the parsed body is a FHIR Bundle. */
export function isBundle(value: unknown): value is Bundle {
  return isRecord(value) && value.resourceType === "Bundle";
}

/** `bundle.entry`, or an empty array when the search matched nothing. */
export function entriesOf(bundle: Bundle): BundleEntry[] {
  return Array.isArray(bundle.entry) ? bundle.entry : [];
}

/**
 * The `next` page URL, or null when this is the last page.
 *
 * The caller must still check that the URL's origin matches the FHIR base before
 * following it: the bearer token goes on that request.
 */
export function nextLink(bundle: Bundle): string | null {
  const links = Array.isArray(bundle.link) ? bundle.link : [];
  for (const link of links) {
    if (link.relation === "next" && typeof link.url === "string" && link.url !== "") {
      return link.url;
    }
  }
  return null;
}

/** Every resource in the bundle of the given type, whatever its search mode. */
export function resourcesOfType<T extends Resource = Resource>(
  bundle: Bundle,
  resourceType: string,
): T[] {
  const out: T[] = [];
  for (const entry of entriesOf(bundle)) {
    const resource = entry.resource;
    if (isRecord(resource) && resource.resourceType === resourceType) {
      out.push(resource as unknown as T);
    }
  }
  return out;
}

export interface SplitEntries {
  /** Entries whose `search.mode` is not `outcome`: the actual hits and includes. */
  matches: Resource[];
  /**
   * The bodies of `search.mode === "outcome"` entries, unparsed.
   * `parseIssues` turns each one into issues; they are never search results.
   */
  outcomes: unknown[];
}

/**
 * Split a page into matched resources and the OperationOutcome entries Epic
 * interleaves to report warnings (4101 no results, 4119 filtered view, 4122
 * unknown parameter).
 *
 * Sharp edge this exists for: an outcome entry looks like any other entry, so a
 * naive `entry.map(e => e.resource)` silently turns a warning into a search
 * result.
 */
export function splitEntries(bundle: Bundle): SplitEntries {
  const matches: Resource[] = [];
  const outcomes: unknown[] = [];
  for (const entry of entriesOf(bundle)) {
    const resource: unknown = entry.resource;
    if (
      entry.search?.mode === "outcome" ||
      (isRecord(resource) && resource.resourceType === "OperationOutcome")
    ) {
      if (resource !== undefined) outcomes.push(resource);
      continue;
    }
    if (isRecord(resource)) matches.push(resource as unknown as Resource);
  }
  return { matches, outcomes };
}

/**
 * A stable `Type/id` key for de-duplicating across pages.
 *
 * Needed because a paging session that expires mid-run (Epic 4113) is restarted
 * from the first page, and because page boundaries shift between requests.
 */
export function resourceKey(resource: Resource): string {
  const type = typeof resource.resourceType === "string" ? resource.resourceType : "?";
  const id = typeof resource.id === "string" ? resource.id : "";
  return `${type}/${id}`;
}
