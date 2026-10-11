/**
 * Turning a document attachment into text a model can read.
 *
 * Pure functions, no bindings, no I/O -- which is why they live here rather than
 * in `binary.ts`: this half is exercised by the plain-Node unit suite, and the
 * half that talks to a health system is not. That includes classifying and
 * matching a `get_document_text` id argument: deciding what an id string names,
 * and which of a `DocumentReference`'s attachments a Binary reference points at,
 * is ordinary string and structure matching over data the caller already has --
 * only the two cache/repo lookups that use the result belong in `binary.ts`.
 *
 * Deliberately narrow. `text/plain` passes through, HTML and RTF are flattened,
 * and everything else is refused. Handing a model the base64 of a PDF does not
 * produce a summary of the PDF; it produces a confident summary of nothing.
 */

import type * as fhir4 from "fhir/r4";

/** Decode base64 (standard or url-safe, whitespace tolerated) as UTF-8 text. */
export function decodeBase64Utf8(data: string): string {
  const normalised = data.replaceAll(/\s+/gu, "").replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalised);
  const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
  return new TextDecoder().decode(bytes);
}

const DOCUMENT_REFERENCE_PREFIX = "DocumentReference/";

/**
 * `Binary/<id>` out of a relative reference or an absolute URL.
 *
 * Used two ways: parsing the `id` argument `get_document_text` was called with,
 * and parsing an `attachment.url` out of a cached `DocumentReference` to see
 * which Binary it names -- the same extraction, because a model copies the
 * latter straight out of `attachments[].url` in `get_documents`' answer and hands
 * it back as the former.
 */
export function binaryIdFromUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const match = /(?:^|\/)Binary\/([^/?#]+)/u.exec(url);
  return match?.[1];
}

/** What a `get_document_text` `id` argument named. */
export type ParsedDocumentId =
  | { kind: "binary"; id: string }
  | { kind: "documentReference"; id: string }
  | { kind: "bare"; id: string };

/**
 * Classify a `get_document_text` id argument.
 *
 * A model naturally copies a document's `attachments[].url` (a Binary reference)
 * rather than its `id` (the DocumentReference), so both are accepted:
 *
 *  - `Binary/<id>`, or an absolute URL ending in `/Binary/<id>` -> `"binary"`.
 *  - `DocumentReference/<id>` -> `"documentReference"`, prefix stripped.
 *  - anything else -> `"bare"`.
 *
 * A bare id is ambiguous on purpose: every existing caller passes a bare
 * DocumentReference id, but the id of a `Binary` is just as plausibly bare. This
 * function only classifies the string; `binary.ts` is what tries a `"bare"` id as
 * a DocumentReference id first (preserving every existing caller) and falls back
 * to treating it as a Binary id only when that lookup misses.
 */
export function parseDocumentTextId(rawId: string): ParsedDocumentId {
  const binaryId = binaryIdFromUrl(rawId);
  if (binaryId !== undefined) return { kind: "binary", id: binaryId };
  return rawId.startsWith(DOCUMENT_REFERENCE_PREFIX)
    ? { kind: "documentReference", id: rawId.slice(DOCUMENT_REFERENCE_PREFIX.length) }
    : { kind: "bare", id: rawId };
}

/** The little a cache write or a fetch needs to know about one attachment. */
export interface DocumentAttachment {
  contentType: string;
  /** Inline base64, when the organisation supplied it. */
  data?: string | undefined;
  /** The `Binary` id, when it did not. */
  binaryId?: string | undefined;
}

export function isDocumentReference(value: unknown): value is fhir4.DocumentReference {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { resourceType?: unknown }).resourceType === "DocumentReference" &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

/** The first attachment that could plausibly become text. */
export function pickAttachment(document: fhir4.DocumentReference): DocumentAttachment | null {
  for (const content of document.content) {
    const { attachment } = content;
    const contentType = attachment.contentType ?? "";
    if (!isConvertible(contentType)) continue;
    const binaryId = binaryIdFromUrl(attachment.url);
    if (binaryId === undefined && attachment.data === undefined) continue;
    return {
      contentType,
      ...(attachment.data !== undefined && { data: attachment.data }),
      ...(binaryId !== undefined && { binaryId }),
    };
  }
  return null;
}

/**
 * The one attachment a Binary reference names, when it names a convertible one.
 *
 * Unlike `pickAttachment`'s "first one that will do", a caller who named a
 * specific Binary gets that attachment or nothing -- never a different one that
 * happens to convert. Checking `isConvertible` here, before any Binary is
 * fetched, is what keeps a request for a document's PDF attachment from spending
 * a metered fetch only to be told `unsupported_document` afterwards: the
 * DocumentReference already says what the attachment's type is.
 */
export function attachmentForBinary(
  document: fhir4.DocumentReference,
  binaryId: string,
): DocumentAttachment | null {
  for (const content of document.content) {
    const { attachment } = content;
    if (binaryIdFromUrl(attachment.url) !== binaryId) continue;
    const contentType = attachment.contentType ?? "";
    return isConvertible(contentType) ? { contentType, binaryId } : null;
  }
  return null;
}

/** The handful of entities a clinical note actually contains. */
const ENTITIES: readonly [RegExp, string][] = [
  [/&nbsp;/giu, " "],
  [/&lt;/giu, "<"],
  [/&gt;/giu, ">"],
  [/&quot;/giu, '"'],
  [/&#0?39;/giu, "'"],
  [/&apos;/giu, "'"],
  // Last: decoding it earlier would let `&amp;lt;` become `<`.
  [/&amp;/giu, "&"],
];

/**
 * Collapse runs of spaces and blank lines without eating paragraph breaks.
 *
 * Spaces only, never tabs: a tab is the one horizontal character a clinical note
 * uses structurally (RTF `\tab` in a tabulated result), and collapsing it into a
 * space turns a small table into a run-on line.
 */
function tidy(value: string): string {
  // Line by line rather than with a whitespace-around-newline regex: `trim()` says
  // exactly what is wanted at the ends of a line, and it cannot be read as
  // ambiguous backtracking the way `[\t ]*\n[\t ]*` can. `trim` touches only the
  // ends, so a tab inside a line survives.
  const lines = value.replaceAll("\r\n", "\n").split("\n");
  const tidied = lines.map((line) => line.replaceAll(/ {2,}/gu, " ").trim());
  return tidied
    .join("\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();
}

/**
 * Remove every tag, repeating until nothing changes.
 *
 * One pass is not enough: removing the inner tag of `<scr<b>ipt>` joins the
 * pieces either side into a new `<script>`. Every pass that changes the text
 * shortens it, so the loop ends, and ordinary markup settles in one or two.
 */
function stripTags(html: string): string {
  let previous: string;
  let text = html;
  do {
    previous = text;
    text = text.replaceAll(/<[^<>]*>/gu, "");
  } while (text !== previous);
  return text;
}

/**
 * Flatten HTML to readable text: block ends become newlines, tags go.
 *
 * A closing script or style tag may carry whitespace or junk before its `>`
 * (`</script >`, `</script foo>`), and browsers still honour it, so the close
 * patterns accept anything up to the `>` rather than only the bare form.
 */
export function htmlToText(html: string): string {
  let text = stripTags(
    html
      .replaceAll(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/giu, " ")
      .replaceAll(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/giu, " ")
      .replaceAll(/<br\s*\/?>/giu, "\n")
      .replaceAll(/<\/(?:p|div|tr|li|h[1-6]|table|section)\s*>/giu, "\n"),
  );
  // A function replacement, so nothing in the table can be read as a `$1`-style
  // substitution pattern.
  for (const [pattern, replacement] of ENTITIES) {
    text = text.replaceAll(pattern, () => replacement);
  }
  return tidy(text);
}

/**
 * Groups whose contents are metadata, not text.
 *
 * `\*` marks a destination an unknowing reader may skip, but the tables RTF has
 * always had are not marked that way, so they are named. The match is lazy and
 * stops at the first `}`, which leaves a stray brace behind on a nested group --
 * harmless, because the brace strip below removes it, and the words inside are
 * gone either way.
 */
const RTF_DESTINATIONS =
  /\{\\(?:\*|fonttbl|colortbl|stylesheet|info|pict|listtable|listoverridetable|rsidtbl|generator|themedata|latentstyles|datastore|xmlnstbl)[\s\S]*?\}/giu;

/**
 * Flatten RTF to readable text.
 *
 * Best effort, and it says so: destination groups (font tables, stylesheets,
 * embedded objects) are dropped whole, paragraph and tab controls become
 * whitespace, `\'hh` escapes are decoded as Latin-1, and every other control word
 * is discarded. Enough for the progress notes that actually arrive; not an RTF
 * parser.
 */
export function rtfToText(rtf: string): string {
  const text = rtf
    .replaceAll(RTF_DESTINATIONS, " ")
    // Each consumes one trailing space, which RTF uses purely as a control-word
    // delimiter rather than as content.
    .replaceAll(/\\par\b ?/giu, "\n")
    .replaceAll(/\\line\b ?/giu, "\n")
    .replaceAll(/\\tab\b ?/giu, "\t")
    .replaceAll(/\\'([\da-f]{2})/giu, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replaceAll(/\\[a-z]+-?\d* ?/giu, "")
    .replaceAll(/[{}]/gu, "");
  return tidy(text);
}

/**
 * Convert a decoded body according to its media type.
 *
 * Returns null when the type is one this server will not turn into text, which is
 * the caller's cue to answer `unsupported_document`. An empty content type is
 * treated as plain text: some organisations omit it on a narrative attachment.
 */
export function convertDocument(contentType: string, body: string): string | null {
  const type = contentType.toLowerCase();
  if (type.includes("html") || type.includes("xhtml")) return htmlToText(body);
  if (type.includes("rtf")) return rtfToText(body);
  return type === "" || type.startsWith("text/") ? tidy(body) : null;
}

/** True when `convertDocument` would accept this media type. */
export function isConvertible(contentType: string): boolean {
  return convertDocument(contentType, "") !== null;
}
