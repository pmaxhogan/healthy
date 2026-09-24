// Small, pure conversions from FHIR R4 datatypes to plain strings/numbers.
// Every function here is total (never throws) and side-effect free: missing
// input always yields `undefined`, never a placeholder string.
import type * as fhir4 from "fhir/r4";

/** `CodeableConcept` -> the best available human text: `.text`, else the
 * first coding's `.display`, else its `.code`. */
/**
 * Where {@link codeText} can have read its answer from, below the element
 * `field`: for a `FIELD_ALIASES` entry whose normalized side is a code
 * rendered as text, so a policy rule written against the raw `display` (or
 * `text`, or `code`) of a coding also removes the normalized text made from it.
 */
export function codeTextSources(field: string): string[][] {
  return [
    [field, "text"],
    [field, "coding", "[]", "display"],
    [field, "coding", "[]", "code"],
  ];
}

export function codeText(cc?: fhir4.CodeableConcept): string | undefined {
  if (!cc) {
    return undefined;
  }
  if (cc.text) {
    return cc.text;
  }
  const coding = cc.coding?.[0];
  return coding?.display ?? coding?.code;
}

/** Renders one or more `HumanName`s to a single display string, preferring an
 * "official" or "usual" use over whatever happens to be first. */
export function humanName(name?: fhir4.HumanName[] | fhir4.HumanName): string | undefined {
  if (!name) {
    return undefined;
  }
  const names = Array.isArray(name) ? name : [name];
  if (names.length === 0) {
    return undefined;
  }
  const preferred =
    names.find((candidate) => candidate.use === "official") ??
    names.find((candidate) => candidate.use === "usual") ??
    names[0];
  return formatHumanName(preferred);
}

function formatHumanName(name: fhir4.HumanName | undefined): string | undefined {
  if (!name) {
    return undefined;
  }
  if (name.text) {
    return name.text;
  }
  const parts = [
    ...(name.prefix ?? []),
    ...(name.given ?? []),
    name.family,
    ...(name.suffix ?? []),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** The plain-text lines/city/state/postalCode of the first `Address`. */
export function address(
  addr?: fhir4.Address[] | fhir4.Address,
): { lines?: string[]; city?: string; state?: string; postalCode?: string } | undefined {
  const first = Array.isArray(addr) ? addr[0] : addr;
  if (!first) {
    return undefined;
  }
  const lines = first.line?.filter((line) => line.length > 0);
  const result: { lines?: string[]; city?: string; state?: string; postalCode?: string } = {
    ...(lines && lines.length > 0 && { lines }),
    ...(first.city && { city: first.city }),
    ...(first.state && { state: first.state }),
    ...(first.postalCode && { postalCode: first.postalCode }),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

/** The best phone number out of a `ContactPoint[]`, preferring `use: "work"`. */
export function phone(telecom?: fhir4.ContactPoint[]): string | undefined {
  const phones = telecom?.filter((entry) => entry.system === "phone" && entry.value);
  if (!phones || phones.length === 0) {
    return undefined;
  }
  const preferred = phones.find((entry) => entry.use === "work") ?? phones[0];
  return preferred?.value;
}

/** A `Period` reduced to plain optional start/end strings. */
export function period(p?: fhir4.Period): { start?: string; end?: string } | undefined {
  if (!p) {
    return undefined;
  }
  const result: { start?: string; end?: string } = {
    ...(p.start && { start: p.start }),
    ...(p.end && { end: p.end }),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

/** A `Quantity` reduced to a plain `{value, unit?}`, dropping the rest. */
export function quantity(q?: fhir4.Quantity): { value: number; unit?: string } | undefined {
  if (q?.value === undefined) {
    return undefined;
  }
  return {
    value: q.value,
    ...(q.unit && { unit: q.unit }),
  };
}

/** The first defined, non-empty value out of a list of candidate date strings. */
export function pickDate(...dates: (string | undefined)[]): string | undefined {
  return dates.find((date): date is string => Boolean(date));
}

/** Drops `undefined`/empty entries and duplicates, preserving first-seen order. */
export function dedupeStrings(values: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }

    seen.add(value);
    result.push(value);
  }
  return result;
}
