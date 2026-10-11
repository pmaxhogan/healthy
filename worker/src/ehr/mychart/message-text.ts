/**
 * A Message Center message body, flattened from the portal's HTML to plain text.
 *
 * The body arrives as the portal's own rendering: nested `div`/`span` runs, lists,
 * the odd table, a `<style nonce>` block per message, and occasionally an inline
 * `<img>` whose `src` carries a per-request token. None of the markup is kept --
 * only what a reader would see -- so nothing stored or served can be rendered as
 * HTML, and no tokenised URL survives into the store.
 *
 * Deliberately a text flattener rather than an HTML parser: every pattern below is
 * a single, non-nested quantifier over the whole string, so no input can make it
 * backtrack badly, and the tag strip repeats until nothing changes so a tag split
 * by another (`<scr<b>ipt>`) cannot reassemble.
 */

/** Whole elements whose content is never text: code, CSS and document metadata. */
const HIDDEN_BLOCK = /<(script|style|head|template)\b[^>]*>[\s\S]*?<\/\1\b[^>]*>/giu;

/** An HTML comment, conditional comments included. */
const COMMENT = /<!--[\s\S]*?-->/gu;

/**
 * A line break, `</br>` included: invalid HTML that browsers read as `<br>`, and
 * exactly what the portal's own pages write between the lines of a
 * department's directions.
 */
const LINE_BREAK = /<\/?br\b[^<>]*>/giu;
/** Block ends a reader sees as a new line. A list item's end is not: the next one's start is. */
const BLOCK_END = /<\/(?:p|div|tr|h[1-6]|table|ul|ol|section|article|blockquote|pre)\s*>/giu;
/** A list item's start: shown as a bullet on its own line. */
const LIST_ITEM = /<li\b[^<>]*>/giu;
/** A table cell's end: a space, so neighbouring cells do not run together. */
const CELL_END = /<\/t[dh]\s*>/giu;
const ANY_TAG = /<[^<>]*>/gu;

/** One entity reference: named, decimal or hex. */
const ENTITY = /&(#x[\da-f]{1,6}|#\d{1,7}|[a-z]{2,8});/giu;

/**
 * The named entities message bodies actually carry. A `Map`, read with `get`, so
 * a name taken from the body can never reach an object's prototype.
 */
const NAMED = new Map<string, string>([
  ["nbsp", " "],
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["ndash", "–"],
  ["mdash", "—"],
  ["lsquo", "‘"],
  ["rsquo", "’"],
  ["ldquo", "“"],
  ["rdquo", "”"],
  ["hellip", "…"],
  ["bull", "•"],
  ["middot", "·"],
  ["trade", "™"],
  ["copy", "©"],
  ["reg", "®"],
  ["deg", "°"],
]);

/**
 * Decode every entity in one pass. One pass is what keeps `&amp;lt;` as the text
 * `&lt;` rather than decoding it twice into `<`. An unknown name or an
 * out-of-range number is left exactly as written.
 */
function decodeEntities(text: string): string {
  return text.replaceAll(ENTITY, (whole, body: string) => {
    const lower = body.toLowerCase();
    if (!lower.startsWith("#")) return NAMED.get(lower) ?? whole;
    const codePoint = lower.startsWith("#x")
      ? Number.parseInt(lower.slice(2), 16)
      : Number(lower.slice(1));
    const valid =
      Number.isSafeInteger(codePoint) &&
      codePoint > 0 &&
      codePoint <= 0x10_ff_ff &&
      (codePoint < 0xd8_00 || codePoint > 0xdf_ff);
    return valid ? String.fromCodePoint(codePoint) : whole;
  });
}

/** Remove every tag, repeating until nothing changes (see the module comment). */
function stripTags(html: string): string {
  let previous: string;
  let text = html;
  do {
    previous = text;
    text = text.replaceAll(ANY_TAG, "");
  } while (text !== previous);
  return text;
}

/** Collapse runs of spaces and of blank lines, keeping paragraph breaks. */
function tidy(value: string): string {
  const lines = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const tidied = lines.map((line) => line.replaceAll(/\s+/gu, " ").trim());
  return tidied
    .join("\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();
}

/** The text a reader of this message body sees. */
export function messageText(html: string): string {
  const structural = html
    .replaceAll(COMMENT, " ")
    .replaceAll(HIDDEN_BLOCK, " ")
    .replaceAll(LINE_BREAK, "\n")
    .replaceAll(LIST_ITEM, "\n- ")
    .replaceAll(BLOCK_END, "\n")
    .replaceAll(CELL_END, " ");
  return tidy(decodeEntities(stripTags(structural)));
}
