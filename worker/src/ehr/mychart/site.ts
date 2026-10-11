/**
 * "Is this still the same site?", by a deliberately small eTLD+1 heuristic.
 *
 * Two rules in this directory need it and neither can ask a real public-suffix
 * list: a Worker has no room for one, and both questions are about a single
 * known portal rather than the whole internet.
 *
 *   - `portalFetch` follows redirects by hand, and a redirect that leaves the
 *     site the owner confirmed must not silently relocate where a password is
 *     sent (`http.ts`).
 *   - the cookie jar has to refuse a `Domain=` attribute that names a public
 *     suffix, or a response from `a.b.example.co.uk` could set a cookie for
 *     every `*.co.uk` host (`cookie-jar.ts`).
 *
 * The heuristic: the registrable domain is the last two labels, except under a
 * known second-level suffix (`co.uk`, `com.au`, …), where it is the last three.
 * That is wrong for exotic suffixes a real list would know about, and it is
 * wrong in the **conservative** direction for the two callers above: it can
 * treat two genuinely different sites as one only when they share their last
 * two labels, which is the case a full list would also accept for a suffix it
 * did not know. An IP literal and a single-label host are their own site.
 */

/**
 * Second-level suffixes common enough to matter, where the registrable domain
 * is three labels rather than two.
 *
 * Not exhaustive and not meant to be -- see the module comment. Entries are
 * lower-case and carry no leading dot.
 */
const SECOND_LEVEL_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk",
  "org.uk",
  "me.uk",
  "ac.uk",
  "gov.uk",
  "net.uk",
  "sch.uk",
  "co.jp",
  "or.jp",
  "ne.jp",
  "ac.jp",
  "go.jp",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "co.nz",
  "org.nz",
  "net.nz",
  "govt.nz",
  "com.br",
  "com.mx",
  "com.ar",
  "com.sg",
  "com.hk",
  "com.tw",
  "com.tr",
  "com.cn",
  "co.in",
  "co.za",
  "co.kr",
  "co.il",
  "com.ua",
]);

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/** The lower-cased hostname of a URL, or "" when it is not one. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * The registrable domain of `host`: what "same site" compares.
 *
 * Returns `host` itself for an IP literal, a single-label name, or anything
 * this cannot split -- each of which is then only ever the same site as itself.
 */
export function registrableDomain(host: string): string {
  const name = host.trim().toLowerCase().replace(/\.$/u, "");
  if (name === "" || IPV4.test(name) || name.includes(":")) return name;
  const labels = name.split(".");
  if (labels.length <= 2) return name;
  const lastTwo = labels.slice(-2).join(".");
  return SECOND_LEVEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

/**
 * Whether `domain` is a public suffix rather than a name someone registers.
 *
 * True for a bare TLD or single label (`test`, `localhost`) and for a known
 * second-level suffix (`co.uk`). False for anything with a registrable name in
 * front of one (`example.co.uk`, `a.example.test`).
 *
 * The cookie jar uses it to refuse a `Domain=` attribute that names a suffix: a
 * response from `a.b.example.co.uk` may legally set `Domain=example.co.uk`, but
 * `Domain=co.uk` would make the jar send that cookie to every sibling host under
 * it. RFC 6265 §5.3 step 5.
 *
 * What it does not know is a suffix outside `SECOND_LEVEL_SUFFIXES` -- a real
 * public-suffix list knows hundreds, including ones like `github.io` that look
 * like ordinary domains. For an unknown one this answers false, i.e. accepts a
 * cookie a browser would refuse. That is the unsafe direction, and it is the
 * trade-off the module comment describes: this jar only ever talks to the one
 * portal host the owner confirmed, and the rule above the unknown-suffix case
 * (the domain must be a label-boundary suffix of the host that sent it) is what
 * carries the weight.
 */
export function isPublicSuffix(domain: string): boolean {
  const name = domain.trim().toLowerCase().replace(/\.$/u, "");
  return name === "" || name.split(".").length < 2 || SECOND_LEVEL_SUFFIXES.has(name);
}

/**
 * Whether two absolute URLs are on the same registrable domain.
 *
 * False when either is not a parseable URL, which is the safe answer: the
 * callers use this to decide whether movement is allowed.
 */
export function sameRegistrableSite(a: string, b: string): boolean {
  const left = hostOf(a);
  const right = hostOf(b);
  return left !== "" && right !== "" && registrableDomain(left) === registrableDomain(right);
}
