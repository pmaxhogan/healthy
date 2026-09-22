/**
 * The little bit of HTML reading the scrape needs, done with string scanning.
 *
 * Deliberately not a parser and deliberately not a dynamic regular expression.
 * Everything here is driven by a handful of *static* patterns plus indexOf, for
 * three reasons: a Worker has no DOM; a regex built from a field name is both an
 * injection surface and a lint failure (`security/detect-non-literal-regexp`);
 * and a catastrophically backtracking pattern on an attacker-influenced page is
 * a denial of service. The patterns below are all bounded and linear.
 *
 * Nothing here returns markup to a caller, and nothing here is ever logged: the
 * page is a patient's own chart, so its text never leaves this module except as
 * a token value, a field name, or a boolean.
 */

/** Every `<input>` tag on the page, whole. Bounded: no nesting to backtrack on. */
const INPUT_TAG = /<input\b[^>]*>/giu;
/** One attribute's value, double-quoted, single-quoted, or bare. */
const NAME_ATTRIBUTE = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/iu;
const VALUE_ATTRIBUTE = /\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/iu;
/** `<meta http-equiv="refresh" content="0;url=...">`, in either attribute order. */
const META_REFRESH = /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/iu;
const CONTENT_ATTRIBUTE = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/iu;
const REFRESH_URL = /url\s*=\s*['"]?([^'";\s]+)/iu;
/**
 * `window.location = "..."` / `location.href = '...'`, and `.replace("...")`.
 *
 * Two simple patterns rather than one that covers both: a single alternation
 * with optional prefixes backtracks badly on a long page, and these run on a
 * body a stranger controls. `\blocation` matches inside `window.location` and
 * `top.location` without having to spell either out.
 */
const SCRIPT_ASSIGN = /\blocation(?:\.href)?\s*=\s*["']([^"']+)["']/iu;
const SCRIPT_REPLACE = /\blocation\.replace\s*\(\s*["']([^"']+)["']/iu;
const NAMED_ENTITY = /&(amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-f]{1,6});/giu;

const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Decode the entity references an HTML attribute value can carry.
 *
 * Load-bearing, not cosmetic: a framework-generated antiforgery token is
 * base64 and its `+` characters are commonly emitted as `&#x2B;`. A token sent
 * back with the escape still in it is rejected, and the failure looks exactly
 * like a wrong password.
 */
function decodeEntities(value: string): string {
  return value.replaceAll(NAMED_ENTITY, (whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (Object.hasOwn(NAMED, lower)) {
      // `Object.hasOwn` above is the proof; NAMED is a closed literal map.
      // eslint-disable-next-line security/detect-object-injection -- guarded by the hasOwn check on a module-private literal map.
      return NAMED[lower] ?? whole;
    }
    const codePoint = Number(lower.startsWith("#x") ? `0x${lower.slice(2)}` : lower.slice(1));
    const inRange = Number.isSafeInteger(codePoint) && codePoint >= 1 && codePoint <= 0x10_ff_ff;
    return inRange ? String.fromCodePoint(codePoint) : whole;
  });
}

function attribute(tag: string, pattern: RegExp): string | null {
  const match = pattern.exec(tag);
  if (match === null) return null;
  const raw = match[1] ?? match[2] ?? match[3] ?? "";
  return decodeEntities(raw);
}

/**
 * Every named `<input>` on the page as name -> value.
 *
 * First occurrence wins: a login page that renders the form twice (a mobile
 * variant below the desktop one is common) must not have its token overwritten
 * by the copy the user cannot see.
 */
export function inputFields(html: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const [tag] of html.matchAll(INPUT_TAG)) {
    const name = attribute(tag, NAME_ATTRIBUTE);
    if (name === null || name === "") continue;
    if (!fields.has(name)) fields.set(name, attribute(tag, VALUE_ATTRIBUTE) ?? "");
  }
  return fields;
}

/**
 * The antiforgery field on this page, found by shape rather than by name.
 *
 * Reading the name out of the page is what makes this work across deployments
 * that renamed the field: `candidates` is only consulted for ordering when the
 * page has more than one, and the shape rule ("a hidden field whose name
 * mentions a verification or antiforgery token") is what actually finds it.
 */
export function findAntiforgeryField(
  html: string,
  candidates: readonly string[] = [],
): { name: string; value: string } | null {
  const fields = inputFields(html);
  for (const candidate of candidates) {
    const value = fields.get(candidate);
    if (value !== undefined && value !== "") return { name: candidate, value };
  }
  for (const [name, value] of fields) {
    const lower = name.toLowerCase();
    const looksRight =
      lower.includes("verificationtoken") ||
      lower.includes("antiforgery") ||
      lower.includes("requestverification") ||
      lower.includes("csrf");
    if (looksRight && value !== "") return { name, value };
  }
  return null;
}

/**
 * Where this page redirects to without an HTTP redirect, if anywhere.
 *
 * Vanity hostnames in the wild answer a login request with a 200 whose body is
 * nothing but a redirect -- as a `<meta http-equiv="refresh">` or a one-line
 * `window.location` assignment. A client that only follows `Location` headers
 * sees a successful page with no login form on it and concludes the mount is
 * wrong, so discovery has to read both.
 */
export function bodyRedirectTarget(html: string): string | null {
  const meta = META_REFRESH.exec(html);
  if (meta !== null) {
    const content = attribute(meta[0], CONTENT_ATTRIBUTE);
    const url = content === null ? null : REFRESH_URL.exec(content);
    if (url?.[1] !== undefined && url[1] !== "") return decodeEntities(url[1]);
  }
  const script = SCRIPT_ASSIGN.exec(html) ?? SCRIPT_REPLACE.exec(html);
  const target = script?.[1];
  // A fragment-only or empty assignment is not a redirect anywhere.
  return target === undefined || target === "" || target.startsWith("#")
    ? null
    : decodeEntities(target);
}

/** True if any of `markers` (already lower-case) appears in the body. */
export function bodyMentions(html: string, markers: readonly string[]): boolean {
  const lower = html.toLowerCase();
  return markers.some((marker) => lower.includes(marker));
}
