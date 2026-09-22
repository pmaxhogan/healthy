// Split out of gate.ts on purpose, and deliberately free of any import of
// `Env`: this is pure string validation, and keeping it that way is what lets
// `test/unit/auth/gate.test.ts` exercise it under the plain-Node tsconfig
// (tsconfig.node.json), which has no worker-configuration.d.ts and therefore
// no D1Database/KVNamespace/etc. Importing `safeNextPath` from `gate.ts`
// itself would still pull in `../env.ts` -- and those runtime ambient types
// with it -- because TypeScript type-checks an entire imported module, not
// just the symbols actually used from it.

/**
 * True if every code point in `value` is a plain, visible-or-space ASCII
 * character -- i.e. none of the C0 controls (0x00-0x1F) or DEL (0x7F). Written
 * as a codepoint scan rather than a `[\x00-\x1F\x7F]` regex, which eslint's
 * `no-control-regex` rejects outright.
 */
function hasNoControlCharacters(value: string): boolean {
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint === 0x7f || codePoint < 0x20) return false;
  }
  return true;
}

/** Only same-origin absolute paths survive, so `?next` can never be an open redirect. */
export function safeNextPath(candidate: string | undefined | null): string | null {
  if (!candidate) return null;
  // `//host` is protocol-relative and `\` is treated as `/` by some browsers;
  // both would leave the origin. A control character -- a raw or `%09`-decoded
  // tab, CR/LF, NUL -- has no business in a path either: some of them can splice
  // a second header into a redirect response depending on how it is later
  // written out, so they are rejected here rather than trusted to stay inert.
  if (
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    !hasNoControlCharacters(candidate)
  ) {
    return null;
  }
  // Bouncing back to the auth endpoints after login is at best a loop.
  return candidate === "/auth" || candidate.startsWith("/auth/") ? null : candidate;
}
