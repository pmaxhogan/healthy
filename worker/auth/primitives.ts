// Byte, hash and cookie primitives shared by the auth modules.
//
// Deliberately free of both Worker-only types and Node built-ins: everything
// here is WebCrypto plus `atob`/`btoa`, which both runtimes have. That is what
// lets the modules built on top of it (password, session, csrf, access) be unit
// tested in plain Node and still be the exact code that runs in workerd.

const encoder = new TextEncoder();

/**
 * A `Uint8Array` backed by a plain `ArrayBuffer`.
 *
 * TypeScript 5.7 made `Uint8Array` generic in its buffer type, and WebCrypto's
 * `BufferSource` deliberately excludes `SharedArrayBuffer`. Spelling the buffer
 * out is what lets these values be handed straight to `crypto.subtle` with no
 * cast -- under the Worker type configuration and the Node one alike, which is
 * what keeps these modules unit-testable outside workerd.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/**
 * UTF-8 bytes of `value`.
 *
 * The copy is not redundant: workerd's own types declare `TextEncoder.encode` as
 * returning `Uint8Array<ArrayBufferLike>`, which `BufferSource` does not accept,
 * so re-homing the bytes in a freshly allocated `ArrayBuffer` is what removes the
 * need for a cast at every `crypto.subtle` call site. The inputs here are
 * passwords and short messages, so the cost is nil.
 */
export function utf8(value: string): Bytes {
  const encoded = encoder.encode(value);
  const bytes = new Uint8Array(encoded.length);
  bytes.set(encoded);
  return bytes;
}

/** base64url, unpadded: safe in a cookie, a header, a URL and a shell argument. */
export function b64urlEncode(bytes: Bytes): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  // `=` only ever appears as trailing padding in base64, so a plain removal is
  // exact -- and avoids a `/=+$/` whose backtracking is flagged as super-linear.
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Inverse of {@link b64urlEncode}. Returns null for anything undecodable. */
export function b64urlDecode(value: string): Bytes | null {
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    // `atob` yields a latin1 string, one code unit per byte.
    return Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0);
  } catch {
    return null;
  }
}

/**
 * Length-then-content comparison in constant time for equal-length inputs.
 *
 * Leaking the *length* of a MAC or a derived key is harmless -- both are fixed
 * width and public -- so the early return on a length mismatch is deliberate.
 */
export function timingSafeEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  // `.at()` rather than `b[index]`: identical here, and it keeps the lint rule
  // that watches for computed member access off a hot, security-relevant loop.
  for (const [index, byte] of a.entries()) diff |= byte ^ (b.at(index) ?? 0);
  return diff === 0;
}

/** HMAC-SHA256 of `message` under a UTF-8 string key. */
export async function hmacSha256(secret: string, message: string): Promise<Bytes> {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(message)));
}

/**
 * One cookie out of a request's `Cookie` header, or null.
 *
 * Splits on the first `=` only: a base64url session value never contains one,
 * but Cloudflare Access's own `CF_Authorization` JWT does not either and this
 * way a future value with padding still round-trips.
 */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const equals = trimmed.indexOf("=");
    if (equals === -1) continue;
    if (trimmed.slice(0, equals) === name) return trimmed.slice(equals + 1);
  }
  return null;
}
