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
/** Every `<form>` opening tag. Bounded for the same reason `INPUT_TAG` is. */
const FORM_TAG = /<form\b[^>]*>/giu;
const ID_ATTRIBUTE = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/iu;
const ACTION_ATTRIBUTE = /\baction\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/iu;
/**
 * A whole `<noscript>...</noscript>` element, including its content.
 *
 * A lazy `[\s\S]*?` bounded by a literal closing tag: one scan for the nearest
 * `</noscript>`, not a pattern that can backtrack across the page.
 */
const NOSCRIPT_ELEMENT = /<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/giu;
/** `<meta http-equiv="refresh" content="0;url=...">`, in either attribute order. */
const META_REFRESH = /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/iu;
const CONTENT_ATTRIBUTE = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/iu;
const REFRESH_URL = /url\s*=\s*['"]?([^'";\s]+)/iu;
/**
 * `window.location = "..."` / `location.href = '...'`, restricted to the
 * page's OWN location: bare `location`, or `window.`/`self.`/`document.`
 * prefixed. Never `top.location`, `parent.location`, or either through
 * `window.` -- those fire only when the page is framed, and a classic login
 * page's own clickjacking guard is exactly
 * `if (self === top) { ... } else { top.location = "..."; }`. Unconditional
 * string-scanning has no way to know the `if` never took that `else` branch
 * on an un-framed load, so the one safe rule is to never treat a
 * `top.location` or `parent.location` assignment -- however it is reached --
 * as a same-page redirect at all.
 *
 * The leading `(?<![\w$.])` is what makes that precise rather than a
 * denylist of the two known bad prefixes: it refuses a match whose
 * `location` (or its allowed prefix) is itself preceded by an identifier
 * character or a `.`, which is what `top.location`, `window.top.location`,
 * `opener.location` and the rest all have in common -- and it is a
 * single-character, fixed-width lookbehind, so it stays exactly as bounded
 * and linear as every other pattern in this module.
 *
 * Two simple patterns rather than one that covers both assignment and the
 * `.replace()`/`.assign()` calls: a single alternation with optional
 * prefixes backtracks badly on a long page, and these run on a body a
 * stranger controls.
 */
const SCRIPT_ASSIGN =
  /(?<![\w$.])(?:(?:window|self|document)\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/iu;
/** `location.replace("...")` / `location.assign("...")`, same restriction. */
const SCRIPT_REPLACE =
  /(?<![\w$.])(?:(?:window|self|document)\.)?location\.(?:replace|assign)\s*\(\s*["']([^"']+)["']/iu;
const NAMED_ENTITY = /&(amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-f]{1,6});/giu;
/**
 * [guess] A quoted absolute path whose first segment ends in `webapi`.
 *
 * The one shape of API base a login shell has been seen to mount its JSON
 * endpoints under. Bounded: a single segment of at most 32 characters, anchored
 * on the quote or paren that opens the string literal it sits in, so it cannot
 * backtrack across a bundle. Deliberately a *hint* -- the real value names the
 * organisation and can have no default, so a miss is normal and the caller
 * supplies the value instead.
 */
const API_BASE_HINT = /["'(](\/[a-z][\w-]{0,31}webapi)(?=[/"'?)])/iu;

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
 * A form this page expects a script to submit for it, by the form's `id`.
 *
 * The OpenID handoff stub is a page with no visible content: a hidden form whose
 * fields are the authorization request, and a script whose only job is to submit
 * it. A client that follows redirects but not that submit stops one hop short of
 * the sign-in, so the bridge has to do the submit itself.
 *
 * The fields are every named `<input>` on the page rather than only the ones
 * inside this form: the stub carries nothing else, `inputFields` is already the
 * bounded scanner this module is built on, and pairing tags with their closing
 * `</form>` would mean actually parsing. If a future stub grows a second form
 * this will send too much, which the authorization endpoint ignores.
 *
 * `ids` is matched case-insensitively and in order, and the action is returned
 * exactly as written -- relative, which the caller resolves against the page.
 */
export function autoSubmitForm(
  html: string,
  ids: readonly string[],
): { action: string; fields: Map<string, string> } | null {
  const wanted = new Set(ids.map((id) => id.toLowerCase()));
  for (const [tag] of html.matchAll(FORM_TAG)) {
    const id = attribute(tag, ID_ATTRIBUTE);
    if (id === null || !wanted.has(id.toLowerCase())) continue;
    const action = attribute(tag, ACTION_ATTRIBUTE);
    if (action === null || action === "") continue;
    return { action, fields: inputFields(html) };
  }
  return null;
}

/**
 * [confirmed] The handoff stub's own controller call, when it carries the
 * authorization URL as a literal argument rather than rendering a form at all.
 *
 * A live, unauthenticated fetch of a real `custom_oidc` deployment's stub
 * confirmed the shape: `new ....OpenIdRequestController(nonce, state,
 * codeVerifier, url, workflow, submitForm)`, all six arguments already filled
 * in server-side. The controller's own script -- the one `MARKERS.openIdHandoff`
 * already matches by name -- does exactly one of two things with them: when
 * `submitForm` is `true` it submits `#OIDCForm` (`autoSubmitForm` above, tried
 * first because a form only exists on the page at all in that case); when it is
 * `false` it does `window.location = url` *from inside that external, cached
 * script*, which this module has no way to run. Reading `url` off of this
 * constructor call, rather than trying to find a `location` assignment inline,
 * is the only way to follow that hop -- there is no assignment in the fetched
 * page to find.
 */
const OIDC_REQUEST_CALL = /OpenIdRequestController\(([^()]*)\)/iu;

/**
 * One argument of that call: a double-quoted string, or a bare boolean.
 * Applied to the short, already-isolated argument list `OIDC_REQUEST_CALL`
 * captured -- never the whole page -- so a comma inside a quoted value (the
 * URL argument routinely has several, none of them raw commas, but nothing
 * here assumes that) never gets mistaken for an argument separator: this
 * tokenises quoted spans instead of splitting on `,`.
 */
const OIDC_ARG = /"([^"]*)"|(true|false)/giu;

/**
 * A `\uXXXX` escape, exactly as a JS string literal inside a `<script>` tag
 * carries one -- distinct from `decodeEntities`'s HTML character references,
 * which this text never goes through at all (it is JS source, not markup).
 */
const JS_UNICODE_ESCAPE = /\\u([0-9a-f]{4})/giu;

function decodeJsUnicodeEscapes(value: string): string {
  return value.replaceAll(JS_UNICODE_ESCAPE, (_whole, hex: string) =>
    String.fromCodePoint(Number.parseInt(hex, 16)),
  );
}

export interface OpenIdRequest {
  /** The already-minted authorization URL, decoded, exactly as the page carries it. */
  url: string;
  /** True when the page means to submit a form instead of navigating here. */
  submitForm: boolean;
}

/**
 * The handoff stub's controller call, parsed. Null when the page carries none
 * -- a stub that renders `#OIDCForm` and nothing else matches `autoSubmitForm`
 * and never needs this, and a page that is not this stub at all naturally has
 * neither.
 *
 * The constructor's six arguments are nonce, state, PKCE verifier, the URL,
 * a workflow label, and the submit-a-form boolean, in that fixed order -- so
 * the fourth and sixth positions of whatever `OIDC_ARG` finds, in order, are
 * `url` and `submitForm`.
 */
export function parseOpenIdRequest(html: string): OpenIdRequest | null {
  const call = OIDC_REQUEST_CALL.exec(html);
  if (call === null) return null;
  const list = call[1] ?? "";
  const args = Array.from(list.matchAll(OIDC_ARG), (arg) => arg[1] ?? arg[2] ?? "");
  const url = args[3];
  return url === undefined || url === ""
    ? null
    : { url: decodeJsUnicodeEscapes(url), submitForm: args[5] === "true" };
}

/**
 * The inputs of one `<form>`, scoped to that form alone -- never the whole
 * page.
 *
 * Matched by `id`, by an `action` ending in `actionSuffix`, or both when both
 * are given (a form must satisfy every criterion supplied). A form's own
 * closing tag is the next literal `</form` after its opening tag: forms do not
 * nest in HTML, so that is exact rather than a heuristic, bounded and linear
 * the same way every other scan in this module is.
 *
 * This is what `autoSubmitForm` above deliberately does not do: that one reads
 * every input on the *page*, because the OpenID stub carries nothing else. A
 * classic login page is the opposite case -- it can render a second,
 * never-submitted form next to the one a script actually posts (see
 * `client.ts`'s "envelope" handling), and echoing that other form's fields
 * back on a POST is a field a real browser never would have sent.
 */
export function formFields(
  html: string,
  match: { id?: string; actionSuffix?: string },
): { action: string; fields: Map<string, string> } | null {
  const wantedId = match.id?.toLowerCase();
  const wantedSuffix = match.actionSuffix?.toLowerCase();
  for (const formMatch of html.matchAll(FORM_TAG)) {
    const tag = formMatch[0];
    const action = attribute(tag, ACTION_ATTRIBUTE);
    if (action === null || action === "") continue;
    if (wantedId !== undefined && attribute(tag, ID_ATTRIBUTE)?.toLowerCase() !== wantedId) {
      continue;
    }
    if (wantedSuffix !== undefined && !action.toLowerCase().endsWith(wantedSuffix)) continue;
    const start = formMatch.index + tag.length;
    const end = html.indexOf("</form", start);
    const body = end === -1 ? html.slice(start) : html.slice(start, end);
    return { action, fields: inputFields(body) };
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
 *
 * A `<noscript>` element's content is stripped before either pattern is tried.
 * It exists for a browser that will not run the page's scripts, so its own
 * `<meta refresh>` or inline script is exactly the fallback a browser *with*
 * JavaScript -- which this client impersonates -- never reaches. Reading it
 * anyway walks the scrape one hop past every page that has both a real handoff
 * and a no-JS fallback, onto a page with none of the markers that identify it.
 *
 * A `top.location` or `parent.location` assignment is never read as a
 * redirect, framed or not: see `SCRIPT_ASSIGN`'s comment for why a classic
 * login page's own clickjacking guard would otherwise look exactly like one.
 */
export function bodyRedirectTarget(html: string): string | null {
  const scripted = html.replaceAll(NOSCRIPT_ELEMENT, "");
  const meta = META_REFRESH.exec(scripted);
  if (meta !== null) {
    const content = attribute(meta[0], CONTENT_ATTRIBUTE);
    const url = content === null ? null : REFRESH_URL.exec(content);
    if (url?.[1] !== undefined && url[1] !== "") return decodeEntities(url[1]);
  }
  const script = SCRIPT_ASSIGN.exec(scripted) ?? SCRIPT_REPLACE.exec(scripted);
  const target = script?.[1];
  // A fragment-only or empty assignment is not a redirect anywhere.
  return target === undefined || target === "" || target.startsWith("#")
    ? null
    : decodeEntities(target);
}

/**
 * A best-effort guess at the path a login shell mounts its JSON API under.
 *
 * Returns null far more often than not, and that is the expected outcome: the
 * value names an organisation, so there is nothing to fall back to and the owner
 * supplies it. Never logged, and only ever returned to discovery, which stores it
 * in the same sealed-adjacent endpoint JSON the mount path lives in.
 */
export function apiBasePathHint(html: string): string | null {
  return API_BASE_HINT.exec(html)?.[1] ?? null;
}

/** True if any of `markers` (already lower-case) appears in the body. */
export function bodyMentions(html: string, markers: readonly string[]): boolean {
  const lower = html.toLowerCase();
  return markers.some((marker) => lower.includes(marker));
}
