/**
 * A small RFC 6265 cookie jar.
 *
 * The portal is a server-rendered application behind a session cookie, so the
 * scrape needs a jar. It does not need a general-purpose one: no third-party
 * rules, no public-suffix list, no SameSite (nothing here is a browser
 * navigation). What it does need to get right is the handful of rules that are
 * security-relevant or that break a login when they are wrong:
 *
 *  - **Domain rejection (§5.3 step 6).** A `Domain=` attribute that does not
 *    domain-match the host that sent it is refused. Without this, one redirect
 *    hop through a vanity host could plant a cookie that this jar would then
 *    send to a different host -- the jar would become the confused deputy.
 *  - **Host-only vs domain cookies (§5.3 step 7).** No `Domain` attribute means
 *    the cookie goes back only to that exact host.
 *  - **Default path (§5.1.4).** The directory of the request path, not "/".
 *    A deployment mounted under a prefix sets cookies scoped to that prefix.
 *  - **`Secure`.** Never sent over plain http, whatever the jar holds.
 *  - **`Max-Age` beats `Expires` (§5.3 step 3)**, and a non-positive `Max-Age`
 *    deletes the cookie immediately.
 *  - **Send order (§5.4).** Longer paths first, then oldest first. Some
 *    applications read the first of two same-named cookies.
 *
 * **Session cookies are persisted.** A cookie with no expiry is, by the letter
 * of the spec, discarded when the "session" ends -- but the whole point of
 * sealing this jar into D1 is that the *next* scheduled run inherits a working
 * session and does not have to ask the owner for an emailed code. So a session
 * cookie survives serialisation here, and `isSessionAlive()` on the client is
 * what deals with the case where the server forgot about it. That is a
 * deliberate deviation, not an oversight.
 *
 * Nothing in this module logs. A cookie value is a credential; the jar's own
 * failures are returned as booleans and the caller decides what to say.
 */

/** One stored cookie. Serialised as-is, so the field names are the file format. */
export interface StoredCookie {
  name: string;
  value: string;
  /** Lower-case, no leading dot. */
  domain: string;
  path: string;
  secure: boolean;
  /** True when there was no `Domain` attribute: send to `domain` and nothing else. */
  hostOnly: boolean;
  /** Unix seconds, or null for a session cookie. */
  expiresAt: number | null;
  /** Unix seconds. Only used to order the header (§5.4). */
  createdAt: number;
}

/** The sealed shape. Versioned so a future format change is detectable. */
export interface CookieJarState {
  v: 1;
  cookies: StoredCookie[];
}

export interface CookieJarOptions {
  /** Unix seconds. Injected so expiry is testable without waiting. */
  now?: () => number;
}

const STATE_VERSION = 1;

/** Attribute-less separator split: `name=value; Path=/; Secure`. */
function splitAttributes(header: string): string[] {
  return header.split(";").map((part) => part.trim());
}

function parseNameValue(pair: string): { name: string; value: string } | null {
  const separator = pair.indexOf("=");
  // A cookie with no "=" is not a cookie; a cookie with an empty name is not
  // either (RFC 6265 §5.2 step 2).
  return separator <= 0
    ? null
    : { name: pair.slice(0, separator).trim(), value: pair.slice(separator + 1).trim() };
}

/** §5.1.3, with the IP-address case folded in: an IP only ever matches itself. */
export function domainMatches(host: string, domain: string): boolean {
  if (host === domain) return true;
  if (!host.endsWith(`.${domain}`)) return false;
  // An IPv4 literal ends in a digit; "10.0.0.1" must not match domain "0.0.1".
  return !/^\d+\.\d+\.\d+\.\d+$/u.test(host);
}

/** §5.1.4. `/a/b` matches request paths `/a/b`, `/a/b/c`, and `/a/b?x` only. */
export function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  // Either the cookie path already ends in a slash, or the request path's next
  // character has to be one -- so `/MyChart` does not match `/MyChartAdmin`.
  const onBoundary = cookiePath.endsWith("/") || requestPath.charAt(cookiePath.length) === "/";
  return onBoundary && requestPath.startsWith(cookiePath);
}

/** §5.1.4: the default path is the *directory* of the request path. */
export function defaultPath(requestPath: string): string {
  if (!requestPath.startsWith("/")) return "/";
  const lastSlash = requestPath.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : requestPath.slice(0, lastSlash);
}

function expiryOf(
  attributes: readonly { name: string; value: string }[],
  now: number,
): number | null {
  // §5.3 step 3: Max-Age wins over Expires wherever both are present.
  const maxAge = attributes.find((a) => a.name === "max-age");
  if (maxAge !== undefined) {
    const seconds = Number(maxAge.value);
    if (!Number.isFinite(seconds)) return null;
    return seconds <= 0 ? 0 : now + seconds;
  }
  const expires = attributes.find((a) => a.name === "expires");
  if (expires === undefined) return null;
  const ms = Date.parse(expires.value);
  // An unparseable Expires is ignored, which leaves a session cookie (§5.2.1).
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function isStoredCookie(value: unknown): value is StoredCookie {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Partial<StoredCookie>;
  return (
    typeof c.name === "string" &&
    c.name !== "" &&
    typeof c.value === "string" &&
    typeof c.domain === "string" &&
    typeof c.path === "string" &&
    typeof c.secure === "boolean" &&
    typeof c.hostOnly === "boolean" &&
    typeof c.createdAt === "number" &&
    (c.expiresAt === null || typeof c.expiresAt === "number")
  );
}

export class CookieJar {
  /**
   * Rebuild a jar from what `serialise()` wrote.
   *
   * Tolerant by design: a jar is a cache, and the only cost of an unreadable one
   * is a fresh sign-in. Malformed entries are dropped and unparseable JSON
   * yields an empty jar rather than an exception the caller would have to
   * distinguish from a real failure.
   */
  static deserialise(json: string, options: CookieJarOptions = {}): CookieJar {
    const jar = new CookieJar(options);
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return jar;
    }
    if (typeof parsed !== "object" || parsed === null) return jar;
    const cookies = (parsed as Partial<CookieJarState>).cookies;
    if (!Array.isArray(cookies)) return jar;
    for (const candidate of cookies) {
      if (isStoredCookie(candidate)) jar.put(candidate);
    }
    jar.prune();
    return jar;
  }

  /** Keyed by `name\u0000domain\u0000path`, which is the uniqueness rule in §5.3. */
  private readonly cookies = new Map<string, StoredCookie>();
  private readonly now: () => number;

  constructor(options: CookieJarOptions = {}) {
    this.now = options.now ?? ((): number => Math.floor(Date.now() / 1000));
  }

  private matching(url: string): StoredCookie[] {
    let requestUrl: URL;
    try {
      requestUrl = new URL(url);
    } catch {
      return [];
    }
    this.prune();
    const host = requestUrl.hostname.toLowerCase();
    const secureTransport = requestUrl.protocol === "https:";
    const path = requestUrl.pathname;
    // eslint-disable-next-line unicorn/prefer-iterator-to-array -- Iterator#toArray is ES2025; see serialise().
    const live = [...this.cookies.values()];
    return live.filter((cookie) => {
      if (!secureTransport && cookie.secure) return false;
      if (!pathMatches(path, cookie.path)) return false;
      return cookie.hostOnly ? host === cookie.domain : domainMatches(host, cookie.domain);
    });
  }

  private put(cookie: StoredCookie): void {
    const key = keyOf(cookie);
    // §5.3 step 11: a replacement keeps the original creation time, which is
    // what keeps the send order stable as a session cookie is refreshed.
    const existing = this.cookies.get(key);
    this.cookies.set(key, existing ? { ...cookie, createdAt: existing.createdAt } : cookie);
  }

  private prune(): void {
    const now = this.now();
    for (const [key, cookie] of this.cookies) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= now) this.cookies.delete(key);
    }
  }

  /** The jar as JSON, for sealing into D1. Expired cookies are dropped first. */
  serialise(): string {
    this.prune();
    // eslint-disable-next-line unicorn/prefer-iterator-to-array -- Iterator#toArray is ES2025 and tsconfig.worker.json's lib is ES2022, so it does not type-check here.
    const state: CookieJarState = { v: STATE_VERSION, cookies: [...this.cookies.values()] };
    return JSON.stringify(state);
  }

  /** How many live cookies the jar holds. For tests and for a status badge. */
  get size(): number {
    this.prune();
    return this.cookies.size;
  }

  /** True if a cookie of this name would be sent to `url`. */
  has(url: string, name: string): boolean {
    return this.matching(url).some((cookie) => cookie.name === name);
  }

  clear(): void {
    this.cookies.clear();
  }

  /**
   * Store every `Set-Cookie` on a response.
   *
   * `getSetCookie()` rather than `get("set-cookie")`: several cookies arrive as
   * several headers, and `get` joins them with ", " -- which is unsplittable,
   * because an `Expires` date contains a comma too. Both workerd and Node 18.14+
   * implement `getSetCookie`; the fallback is a single header, which is the
   * common case anyway.
   */
  setFromResponse(url: string, response: Response): number {
    const headers: string[] =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter((value): value is string => value !== null);
    let stored = 0;
    for (const header of headers) {
      if (this.setCookie(url, header)) stored++;
    }
    return stored;
  }

  /**
   * Store one `Set-Cookie` header value.
   *
   * Returns false when the cookie was refused (unparseable, or a `Domain` the
   * sending host has no business setting) or when it was a deletion.
   */
  setCookie(url: string, header: string): boolean {
    let requestUrl: URL;
    try {
      requestUrl = new URL(url);
    } catch {
      return false;
    }
    const parts = splitAttributes(header);
    const first = parts[0];
    if (first === undefined) return false;
    const pair = parseNameValue(first);
    if (pair === null) return false;

    const attributes = parts.slice(1).map((part) => {
      const parsed = parseNameValue(part);
      return parsed === null
        ? { name: part.toLowerCase(), value: "" }
        : { name: parsed.name.toLowerCase(), value: parsed.value };
    });

    const host = requestUrl.hostname.toLowerCase();
    const domainAttribute = attributes.find((a) => a.name === "domain")?.value ?? "";
    // §5.3 step 5-6: strip the leading dot, then refuse a domain that is not a
    // suffix of the host that sent it.
    const domain = domainAttribute.replace(/^\./u, "").toLowerCase();
    if (domain !== "" && !domainMatches(host, domain)) return false;

    const pathAttribute = attributes.find((a) => a.name === "path")?.value ?? "";
    const expiresAt = expiryOf(attributes, this.now());

    const cookie: StoredCookie = {
      name: pair.name,
      value: pair.value,
      domain: domain === "" ? host : domain,
      path: pathAttribute.startsWith("/") ? pathAttribute : defaultPath(requestUrl.pathname),
      secure: attributes.some((a) => a.name === "secure"),
      hostOnly: domain === "",
      expiresAt,
      createdAt: this.now(),
    };

    // A past expiry is a deletion, not a cookie (§5.3 step 11).
    if (expiresAt !== null && expiresAt <= this.now()) {
      this.cookies.delete(keyOf(cookie));
      return false;
    }
    this.put(cookie);
    return true;
  }

  /**
   * The `Cookie` header value for `url`, or null when nothing matches.
   *
   * Null rather than an empty string: an empty `Cookie` header is a distinct
   * request shape, and this scrape is trying not to have a distinct shape.
   */
  getCookieHeader(url: string): string | null {
    const matching = this.matching(url);
    if (matching.length === 0) return null;
    // §5.4 step 2: longer paths first, then oldest first.
    matching.sort((a, b) => b.path.length - a.path.length || a.createdAt - b.createdAt);
    return matching.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }
}

function keyOf(cookie: StoredCookie): string {
  return `${cookie.name}\u{0}${cookie.domain}\u{0}${cookie.path}`;
}
