// The field-path grammar the exposure policy is written in.
//
// Shared because both sides speak it: the Worker parses and enforces a stored
// path (`worker/policy/`), and the admin UI builds one from the field tree,
// autocompletes the raw path input, and renders a rule as a sentence
// (`src/lib/policy.ts`). One grammar, one parser, so the path the owner sees in
// the builder is the path the filter walks.
//
// A path names a key below the root of one tool answer item (or one raw FHIR
// resource), one segment per level, separated by dots:
//
//   location.address.lines          nested objects
//   participants[].name             `[]`: into every element of an array
//   component[].referenceRange[].low
//   value[x]                        `[x]`: every FHIR choice-type variant of
//                                   `value` -- valueQuantity, valueString, ...
//
// `[]` may also stand alone as a segment (`participants.[].name`), which is the
// same path; the canonical spelling suffixes it to the segment before it. A
// named segment that meets an array at run time steps into every element too,
// so `participants.name` removes the same thing -- `[]` makes it explicit.

/** The path segment standing for "every element of this array". */
export const ARRAY_SEGMENT = "[]";

/** The suffix marking a FHIR choice type: `value[x]` is every `value<Type>` key. */
const CHOICE_SUFFIX = "[x]";

/** Longest path the policy accepts, in characters. Generous; paths are short. */
export const MAX_PATH_LENGTH = 300;

/** The key characters a segment may use. FHIR and the normalized shapes use nothing else. */
const SEGMENT_PATTERN = /^[A-Za-z_][\w-]*(?:\[x\])?$/u;

/** Why a path string was refused, in a sentence the admin UI can show as-is. */
export type PathParse = { ok: true; segments: string[] } | { ok: false; message: string };

/**
 * Split a path into segments, `[]` as a segment of its own.
 *
 * `a[][]` (an array of arrays) is two array segments. A path that is only array
 * markers is refused: it would name the item itself, not a field of it.
 */
export function parsePath(input: string): PathParse {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, message: "the path is empty" };
  if (trimmed.length > MAX_PATH_LENGTH) {
    return { ok: false, message: `the path is longer than ${String(MAX_PATH_LENGTH)} characters` };
  }
  const segments: string[] = [];
  for (const raw of trimmed.split(".")) {
    let segment = raw.trim();
    let arrays = 0;
    while (segment.endsWith(ARRAY_SEGMENT)) {
      segment = segment.slice(0, -ARRAY_SEGMENT.length);
      arrays += 1;
    }
    if (segment.length > 0) {
      if (!SEGMENT_PATTERN.test(segment)) {
        return { ok: false, message: `"${raw.trim()}" is not a field name` };
      }
      segments.push(segment);
    } else if (arrays === 0) {
      return { ok: false, message: "the path has an empty segment (two dots in a row?)" };
    }
    for (let index = 0; index < arrays; index++) segments.push(ARRAY_SEGMENT);
  }
  return segments.every((segment) => segment === ARRAY_SEGMENT)
    ? { ok: false, message: "the path must name a field, not only array markers" }
    : { ok: true, segments };
}

/** Segments back to the canonical string: `[]` suffixed to the segment before it. */
export function formatPath(segments: readonly string[]): string {
  let out = "";
  for (const segment of segments) {
    if (segment === ARRAY_SEGMENT) out += ARRAY_SEGMENT;
    else out += out.length === 0 ? segment : `.${segment}`;
  }
  return out;
}

/** The canonical spelling of a path string, or null when it does not parse. */
export function canonicalPath(input: string): string | null {
  const parsed = parsePath(input);
  return parsed.ok ? formatPath(parsed.segments) : null;
}

/** True when `segment` is a choice-type segment such as `value[x]`. */
export function isChoiceSegment(segment: string): boolean {
  return segment.endsWith(CHOICE_SUFFIX) && segment.length > CHOICE_SUFFIX.length;
}

/**
 * True when `key` is one variant of the choice segment `choice`.
 *
 * `value[x]` matches `valueQuantity` and `valueString` but not `value` itself
 * (a normalized key, not a FHIR choice) and not `values` (lower-case after the
 * stem): FHIR spells every variant as the stem plus a capitalised type name.
 */
export function matchesChoice(choice: string, key: string): boolean {
  const stem = choice.slice(0, -CHOICE_SUFFIX.length);
  if (!key.startsWith(stem) || key.length === stem.length) return false;
  const next = key.charAt(stem.length);
  return next >= "A" && next <= "Z";
}

/**
 * How a path reads in a sentence: `participants → name`, `code → coding → display`.
 *
 * Array markers are dropped: "hide participants → name" already means every
 * participant, and that is how the owner thinks of it.
 */
export function humanPath(segments: readonly string[]): string {
  return segments.filter((segment) => segment !== ARRAY_SEGMENT).join(" → ");
}
