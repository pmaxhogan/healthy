/**
 * Turns the raw MIME stream Cloudflare hands the `email()` handler into the
 * few fields the sign-in flow needs.
 *
 * postal-mime reads the whole message -- headers, HTML, attachments -- but
 * this repository's inbox never stores a body beyond its plain-text part and
 * never an attachment at all: `ParsedMail` is exactly what survives, and
 * `.attachments` is dropped on the floor rather than threaded through as an
 * unused field that would tempt a later change to keep it.
 *
 * `.html` is the one part of the message this file reads without exposing:
 * some portals send a verification code as HTML only, with no `text/plain`
 * alternative at all, and postal-mime leaves `.text` `undefined` in that
 * case. When that happens, `deriveText` flattens `.html` into plain text so
 * `classify()` has something to search -- but only ever the derived text
 * ever leaves this module. The markup itself is never stored, logged, or
 * added to `ParsedMail`.
 */

import PostalMime from "postal-mime";

import { MAX_CLASSIFY_CHARS } from "./classify.ts";

export interface ParsedMail {
  /**
   * The message's own `From:` header address, lower-cased -- never the SMTP
   * envelope sender. `ForwardableEmailMessage.from` is the envelope, and a
   * Gmail filter's "Forward it to" rewrites that to Gmail's own relay
   * address while leaving this header alone; the header is the address the
   * sender allowlist has to match, or every Gmail-forwarded MyChart code
   * would be rejected. See .local/planb-research.md §1.
   */
  from: string;
  subject: string;
  text: string;
  receivedAt: number;
  rawSize: number;
}

/**
 * Parse one inbound message.
 *
 * `rawSize` and `receivedAt` are not part of the MIME content -- they come
 * from `ForwardableEmailMessage.rawSize` and the caller's clock -- but they
 * travel with the parsed fields because every caller needs both together to
 * build a `mail_inbox` row, and threading them separately through
 * `handler.ts` would just reassemble the same object one line later.
 */
export async function parseInboundEmail(
  raw: ReadableStream<Uint8Array> | ArrayBuffer | string,
  rawSize: number,
  receivedAt: number,
): Promise<ParsedMail> {
  const email = await PostalMime.parse(raw);
  return {
    from: (email.from?.address ?? "").trim().toLowerCase(),
    subject: (email.subject ?? "").trim(),
    text: deriveText(email.text, email.html),
    receivedAt,
    rawSize,
  };
}

/**
 * `email.text` when postal-mime found a `text/plain` part with anything in
 * it; otherwise `email.html` flattened to plain text; otherwise `""`.
 *
 * A `text/plain` part always wins when both exist -- it is already what a
 * human is meant to read, so there is nothing for `htmlToText` to improve on
 * and every reason to skip the extra work. HTML is a fallback for the one
 * case that matters here: a portal that sends its verification code as
 * HTML-only mail, whose `.text` postal-mime leaves `undefined`.
 */
function deriveText(text: string | undefined, html: string | undefined): string {
  if (text !== undefined && text.trim() !== "") return text;
  return html === undefined ? "" : htmlToText(html);
}

/**
 * The most HTML `htmlToText` will ever look at.
 *
 * Reuses `classify()`'s own cap (see `worker/mail/classify.ts`) rather than
 * inventing a second number: `classify` never searches past that many
 * characters of subject + text combined, so flattening more HTML than that
 * is pure waste, and capping up front keeps every regex below doing
 * linear-time work over a bounded string no matter how large the sender's
 * HTML part is. (The 1 MB `MAX_RAW_SIZE_BYTES` guard in `handler.ts` bounds
 * the whole raw message before it ever reaches postal-mime, not any one MIME
 * part on its own.)
 */
const MAX_HTML_CHARS = MAX_CLASSIFY_CHARS;

/**
 * Block-level elements whose *content* is never wanted: script and style
 * bodies are code and CSS, not message text, and a `<head>` carries only
 * metadata (title, style, script) that never contains the message the
 * sender meant a reader to see.
 *
 * The backreference (`\1`) is what lets one pattern cover all three tags
 * without also matching `<script>...</style>`. Lazy (`*?`) so it stops at
 * the *nearest* matching close tag rather than the last one in the message;
 * combined with the `MAX_HTML_CHARS` cap above, this is a single quantifier
 * per alternative, not a nested one, so it cannot backtrack catastrophically.
 */
const HIDDEN_BLOCK = /<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Tags whose closing (or, for `<br>`, own) tag marks a line break a reader would see. */
const LINE_BREAK_TAG = /<br\b[^<>]*>/gi;
const LINE_BREAK_CLOSE_TAG = /<\/(?:p|div|tr|li)\s*>/gi;

/** Whatever HTML tag is left once the above have been handled. */
const ANY_TAG = /<[^<>]*>/g;

/** The handful of named entities a verification-code email actually contains. */
const NAMED_ENTITIES: readonly [RegExp, string][] = [
  [/&nbsp;/gi, " "],
  [/&lt;/gi, "<"],
  [/&gt;/gi, ">"],
  [/&quot;/gi, '"'],
  [/&apos;/gi, "'"],
];

const NUMERIC_ENTITY_HEX = /&#x([0-9a-f]+);/gi;
const NUMERIC_ENTITY_DEC = /&#(\d+);/g;

/**
 * Decode one `&#NNN;` / `&#xHH;` numeric entity, or hand the match back
 * unchanged when the digits are not a valid Unicode code point -- malformed
 * input from an unauthenticated sender must never throw and abort parsing.
 */
function decodeNumericEntity(wholeMatch: string, digits: string, base: 10 | 16): string {
  const codePoint = Number.parseInt(digits, base);
  if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10_ff_ff) {
    return wholeMatch;
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return wholeMatch;
  }
}

/**
 * Decode the entities a verification email's HTML actually uses.
 *
 * `&amp;` is decoded last, deliberately: an already-escaped literal "&lt;" in
 * the source arrives over the wire as "&amp;lt;", and decoding `&amp;` before
 * `&lt;` would turn that intentionally-literal text into a real `<`.
 */
function decodeEntities(text: string): string {
  let decoded = text;
  for (const [pattern, replacement] of NAMED_ENTITIES) {
    // A function replacer, not the bare string: `replaceAll` treats a string
    // replacement's `$&`/`$1`-style sequences specially, and nothing here
    // guarantees a future entry in `NAMED_ENTITIES` can never contain one.
    decoded = decoded.replaceAll(pattern, () => replacement);
  }
  decoded = decoded
    .replaceAll(NUMERIC_ENTITY_HEX, (whole: string, hex: string) =>
      decodeNumericEntity(whole, hex, 16),
    )
    .replaceAll(NUMERIC_ENTITY_DEC, (whole: string, dec: string) =>
      decodeNumericEntity(whole, dec, 10),
    );
  return decoded.replaceAll(/&amp;/gi, "&");
}

/** Collapse every run of whitespace (including the newlines block tags became) to one space. */
function collapseWhitespace(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

/**
 * Flatten an HTML message body to plain text good enough for `classify()` to
 * search -- not a renderer, just enough structure that words either side of
 * a block-level boundary do not run together into a token `classify()` would
 * read as something else.
 *
 * Every regex above is capped to `MAX_HTML_CHARS` input and uses a single,
 * non-nested quantifier, so none of this can approach the catastrophic-
 * backtracking blowup a nested quantifier risks on attacker-controlled
 * input.
 */
function htmlToText(html: string): string {
  const capped = html.slice(0, MAX_HTML_CHARS);
  const withoutHiddenBlocks = capped.replaceAll(HIDDEN_BLOCK, " ");
  const withLineBreaks = withoutHiddenBlocks
    .replaceAll(LINE_BREAK_TAG, "\n")
    .replaceAll(LINE_BREAK_CLOSE_TAG, "\n");
  const stripped = withLineBreaks.replaceAll(ANY_TAG, "");
  return collapseWhitespace(decodeEntities(stripped));
}
