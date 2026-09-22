/**
 * Trims a raw Epic sandbox FHIR response down to something safe and small to
 * commit as a test fixture.
 *
 * Epic's sandbox patients are synthetic -- there is no real person behind
 * "Camila Lopez" -- so nothing here exists because the data is sensitive.
 * It exists so fixtures stay small, stable, and free of URLs that name a real
 * Epic host outside the one already named in this codebase
 * (`fhir.epic.com`, the public sandbox base):
 *
 *  - `meta.security` is dropped. It is SMART-on-FHIR consent/segmentation
 *    metadata the sync engine never reads, and it is one of the fields most
 *    likely to vary between recordings for reasons that have nothing to do
 *    with the shape a test wants to assert against.
 *  - Any `extension` entry whose `url` mentions "identity" or "photo" is
 *    dropped. Epic's patient-facing USCDI extensions occasionally carry a
 *    photo reference or an identity-assurance assertion; neither is exercised
 *    by any code path this project has, so there is no reason for a fixture
 *    to carry one.
 *  - `Patient.telecom` is dropped and `Patient.address` is reduced to
 *    `{city, state}`. The sandbox's phone numbers and street addresses are
 *    invented, but they are also irrelevant to every normalizer and test this
 *    repo has, so keeping only the two fields the mapping logic could ever
 *    plausibly want keeps the fixture from ballooning for no reason.
 *  - Absolute URLs under the recorded sandbox base (`fullUrl`, pagination
 *    `link.url`, and similar) are rewritten onto the placeholder host the
 *    unit fixtures already use (see `test/unit/providers/fixtures.ts`,
 *    `TEST_FHIR_BASE`), so a fixture never encodes a live Epic sandbox URL
 *    that a future recording could resolve differently, and integration
 *    tests get the same synthetic host every other fixture in this repo uses.
 *
 * Everything else -- clinical codes, statuses, dates, ids, the synthetic
 * patient's name -- is left alone. It is fabricated sandbox data and it is
 * what the tests exist to assert against.
 */

import { isRecord } from "../../worker/fhir/bundle.ts";

/**
 * The placeholder host every other fixture in this repo already uses (see
 * `test/unit/providers/fixtures.ts`'s `TEST_FHIR_BASE`). Not exported: nothing
 * outside this file needs it, since `ScrubOptions.placeholderBase` is how a
 * caller would override it.
 */
const PLACEHOLDER_FHIR_BASE = "https://fhir.example-health.test/api/FHIR/R4";

const IDENTITY_OR_PHOTO_EXTENSION = /identity|photo/i;

export interface ScrubOptions {
  /** The real base URL the response was recorded from, e.g. the Epic sandbox base. */
  sandboxBase: string;
  /** Defaults to `PLACEHOLDER_FHIR_BASE`. */
  placeholderBase?: string;
}

/** Rewrite one string if it is an absolute URL under `sandboxBase`, else return it unchanged. */
function rewriteUrl(value: string, sandboxBase: string, placeholderBase: string): string {
  if (value === sandboxBase) return placeholderBase;
  return value.startsWith(`${sandboxBase}/`)
    ? placeholderBase + value.slice(sandboxBase.length)
    : value;
}

/** `Patient.address`, reduced to the two fields any mapping logic could plausibly want. */
function scrubAddress(address: unknown): unknown {
  if (!isRecord(address)) return address;
  const kept: Record<string, unknown> = {};
  if ("city" in address) kept.city = address.city;
  if ("state" in address) kept.state = address.state;
  return kept;
}

/** An `extension` array with identity/photo entries removed. */
function scrubExtensions(list: unknown): unknown {
  if (!Array.isArray(list)) return list;
  return list.filter((item: unknown) => {
    if (!isRecord(item)) return true;
    const url = item.url;
    return !(typeof url === "string" && IDENTITY_OR_PHOTO_EXTENSION.test(url));
  });
}

function walk(value: unknown, sandboxBase: string, placeholderBase: string): unknown {
  if (typeof value === "string") return rewriteUrl(value, sandboxBase, placeholderBase);
  if (Array.isArray(value)) {
    return value.map((item: unknown) => walk(item, sandboxBase, placeholderBase));
  }
  if (!isRecord(value)) return value;

  const isPatient = value.resourceType === "Patient";
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === "telecom" && isPatient) continue; // dropped entirely, see the module comment
    if (key === "meta" && isRecord(raw)) {
      const restMeta: Record<string, unknown> = {};
      for (const [metaKey, metaValue] of Object.entries(raw)) {
        if (metaKey !== "security") restMeta[metaKey] = metaValue;
      }
      out[key] = walk(restMeta, sandboxBase, placeholderBase);
      continue;
    }
    if (key === "extension") {
      out[key] = walk(scrubExtensions(raw), sandboxBase, placeholderBase);
      continue;
    }
    if (key === "address" && isPatient && Array.isArray(raw)) {
      out[key] = raw.map((entry: unknown) => scrubAddress(entry));
      continue;
    }
    out[key] = walk(raw, sandboxBase, placeholderBase);
  }
  return out;
}

/** Scrub one parsed JSON body (a Bundle, a single resource, or a CapabilityStatement). */
export function scrubFixture(value: unknown, options: ScrubOptions): unknown {
  const placeholderBase = options.placeholderBase ?? PLACEHOLDER_FHIR_BASE;
  return walk(value, options.sandboxBase, placeholderBase);
}

/**
 * Cap a Bundle's `entry` array at `maxEntries`, so one prolific sandbox patient
 * cannot make a single fixture file balloon.
 *
 * The `next` link is dropped when this actually truncates something: a
 * fixture that claims more pages exist, when the recorder chose not to fetch
 * or keep them, would be misleading to read later. Anything that is not a
 * Bundle, or a Bundle within the cap, is returned unchanged.
 */
export function truncateBundleEntries(value: unknown, maxEntries: number): unknown {
  if (!isRecord(value) || value.resourceType !== "Bundle" || !Array.isArray(value.entry)) {
    return value;
  }
  if (value.entry.length <= maxEntries) return value;

  const link = Array.isArray(value.link)
    ? value.link.filter((entry: unknown) => !(isRecord(entry) && entry.relation === "next"))
    : value.link;
  return { ...value, entry: value.entry.slice(0, maxEntries), link };
}
