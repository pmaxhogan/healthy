/**
 * The calendar event description, shared between Healthy and the owner.
 *
 * Healthy owns everything from a rule line down, and the owner owns everything
 * above it:
 *
 * ```text
 * <whatever the owner typed -- kept verbatim>
 * -------
 * Synced by Healthy · do not edit below the line
 * <the appointment details>
 * ```
 *
 * `healthyBlock` renders Healthy's half. A new event's description is exactly
 * that block. Every later write goes through `mergeDescription`, which keeps the
 * text above the first line that is exactly `-------` byte for byte and replaces
 * everything from that line down. `carriesBlock` is the matching read side: the
 * plan treats an event as settled only when its description still carries the
 * current block, so an edit *below* the line (or a deleted line) is overwritten on
 * the next run, while an edit *above* it costs no write at all.
 *
 * Three shapes of description turn up that the simple case does not cover.
 *
 * **HTML.** A plain-text edit in Google's web editor stays plain text, but once
 * the owner applies any formatting the editor saves the whole description as
 * HTML -- `<br>` (or `<div>`/`<p>` blocks) where the newlines were, `&` as
 * `&amp;`, Healthy's half included. Lines are therefore
 * split on those as well as on `\n`, the owner's HTML is sliced out of the raw
 * string and never re-serialised, and when the owner's part is HTML the block is
 * written as HTML too (escaped, joined with `<br>`), so the two halves render
 * alike. The comparison in `carriesBlock` is on normalised text -- tags as line
 * breaks, the common entities decoded, blank lines ignored -- so Google
 * re-encoding an `&` in an address does not look like a change and cause a patch
 * every hour for ever.
 *
 * **No rule line.** The owner deleted it, or typed over the whole description.
 * The block is appended after whatever is there, which stays above the new line.
 *
 * **The legacy format.** Before the rule line existed, the description was the
 * appointment details followed by a last line reading "Synced by Healthy · do
 * not edit" (and, on a ghost, a "No longer on the health system's schedule" line
 * after that). All of that was Healthy's, so it is replaced wholesale rather than
 * kept above the new line -- keeping it would show every detail twice. Anything
 * after it (a note the owner appended despite the footer) is not part of the old
 * rendering, and is kept above the line. Text the owner put *before* the old
 * details cannot be told apart from them and goes with them: that region was
 * marked "do not edit", and guessing would be worse.
 *
 * Pure and silent. The owner's text is personal content: nothing here logs it,
 * and nothing that calls this stores it.
 *
 * **One line of the details may be a link.** `mapping.ts` turns the visit-type
 * line into a hyperlink (`linkify`) when the health system has a portal url, and
 * that is the one piece of real markup this module ever writes into the block
 * itself. `htmlBlock` has to know that when it escapes the rest of the block for
 * an HTML owner: it recognises a well-formed `<a>`/`</a>` tag structurally (by
 * tag name, the same way `plainText` already reads the owner's own HTML) and
 * copies it through unescaped, so the link keeps working instead of showing up
 * as literal angle brackets. Anything else that merely looks like a tag --
 * including a stray `<` in upstream data -- is escaped like any other
 * character, exactly as it always was.
 */

/** The line that separates the owner's text from Healthy's. Exactly this. */
const RULE = "-------";
/** The line right below the rule. Quoted in tests; do not reword lightly. */
const HEADER = "Synced by Healthy · do not edit below the line";
/** The last line of the pre-rule format, recognised only to migrate it. */
const LEGACY_FOOTER = "Synced by Healthy · do not edit";
/** How a ghost's description says the appointment went away. */
export const VANISHED_PREFIX = "No longer on the health system's schedule as of ";

/** Tags that end a line of text, the way a newline does. */
const BREAK_TAGS: ReadonlySet<string> = new Set(["br", "p", "div", "li", "ul", "ol", "hr"]);
/** Opening tags that wrap a line: a cut before one of those must include the tag. */
const WRAP_TAGS: ReadonlySet<string> = new Set(["p", "div", "li"]);

const ENTITIES: ReadonlyMap<string, string> = new Map([
  ["&nbsp;", " "],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#39;", "'"],
  ["&#x27;", "'"],
  ["&middot;", "·"],
  ["&mdash;", "—"],
  // Last, so "&amp;lt;" decodes to "&lt;" and not to "<".
  ["&amp;", "&"],
]);

/** A literal non-breaking space, which Google's editor types for a doubled space. */
const NBSP = String.fromCodePoint(0xa0);

/** Healthy's half of a description: the rule, the header, then the details. */
export function healthyBlock(details: string): string {
  return `${RULE}\n${HEADER}\n${details}`;
}

/**
 * One line of a description, as offsets into the raw string. `cut` is where the
 * text above this line ends: the line's own start, or the start of the opening
 * `<div>`/`<p>` that wraps it, so a cut there never leaves an unclosed tag.
 */
interface Line {
  start: number;
  end: number;
  cut: number;
}

/** A tag's lower-cased name and whether it is a closing one. Null for `<3` and friends. */
function parseTag(inner: string): { name: string; closing: boolean } | null {
  const closing = inner.startsWith("/");
  let at = closing ? 1 : 0;
  let name = "";
  while (at < inner.length) {
    const char = inner.charAt(at).toLowerCase();
    if (char < "a" || char > "z") break;
    name += char;
    at += 1;
  }
  return name === "" ? null : { name, closing };
}

/**
 * Split on `\n` and on line-breaking tags. A hand-rolled scan rather than a
 * regex: linear however the owner's text is shaped.
 */
function scanLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  let cut = 0;
  let at = 0;
  while (at < text.length) {
    const char = text.charAt(at);
    if (char === "\n") {
      lines.push({ start, end: at, cut });
      at += 1;
      start = at;
      cut = at;
      continue;
    }
    const close = char === "<" ? text.indexOf(">", at) : -1;
    const tag = close === -1 ? null : parseTag(text.slice(at + 1, close));
    if (tag === null || !BREAK_TAGS.has(tag.name)) {
      at += 1;
      continue;
    }
    lines.push({ start, end: at, cut });
    const next = close + 1;
    cut = !tag.closing && WRAP_TAGS.has(tag.name) ? at : next;
    start = next;
    at = next;
  }
  lines.push({ start, end: text.length, cut });
  return lines;
}

/** One line's visible text: tags dropped, entities decoded, edges trimmed. */
function plainText(raw: string): string {
  let out = "";
  let at = 0;
  while (at < raw.length) {
    const char = raw.charAt(at);
    const close = char === "<" ? raw.indexOf(">", at) : -1;
    if (close !== -1 && parseTag(raw.slice(at + 1, close)) !== null) {
      at = close + 1;
      continue;
    }
    out += char;
    at += 1;
  }
  for (const [entity, value] of ENTITIES) out = out.split(entity).join(value);
  return out.split(NBSP).join(" ").trim();
}

function lineText(text: string, line: Line): string {
  return plainText(text.slice(line.start, line.end));
}

/** The visible, non-blank lines of a description, for comparing two renderings. */
function visibleLines(text: string): string[] {
  return scanLines(text)
    .map((line) => lineText(text, line))
    .filter((line) => line !== "");
}

/** The first line that is exactly the rule, or null. */
function findRule(text: string): Line | null {
  return scanLines(text).find((line) => lineText(text, line) === RULE) ?? null;
}

/** True when the text has any tag in it at all: Google has made it HTML. */
function looksLikeHtml(text: string): boolean {
  let at = text.indexOf("<");
  while (at !== -1) {
    const close = text.indexOf(">", at);
    if (close === -1) return false;
    if (parseTag(text.slice(at + 1, close)) !== null) return true;
    at = text.indexOf("<", at + 1);
  }
  return false;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** `escapeHtml`, plus the one character that matters inside a quoted attribute. */
function escapeAttr(url: string): string {
  return escapeHtml(url).replaceAll('"', "&quot;");
}

/**
 * A line of the details as a hyperlink -- the one piece of real markup this
 * module ever writes into a block. Both the visible text and the url are
 * escaped, so a stray `&` or `<` in either (upstream data, or a portal url
 * copied out of a health system's config) cannot break out of the tag.
 */
export function linkify(text: string, url: string): string {
  return `<a href="${escapeAttr(url)}">${escapeHtml(text)}</a>`;
}

/** Tag names `htmlBlock` passes through unescaped: see `linkify`. */
const SAFE_TAGS: ReadonlySet<string> = new Set(["a"]);

/**
 * The block as HTML, to sit below an owner's text that Google has made HTML.
 *
 * Escapes every character except a well-formed `<a>` or `</a>` tag, which is
 * copied through verbatim -- attributes included -- so a link `linkify` wrote
 * stays a link instead of turning into visible markup. `parseTag` (below) is
 * the same recogniser `plainText` uses to read the owner's own HTML, so this
 * treats a tag as structural on exactly the same terms reading already does.
 */
function htmlBlock(block: string): string {
  let out = "";
  let at = 0;
  while (at < block.length) {
    const char = block.charAt(at);
    if (char === "\n") {
      out += "<br>";
      at += 1;
      continue;
    }
    const close = char === "<" ? block.indexOf(">", at) : -1;
    const tag = close === -1 ? null : parseTag(block.slice(at + 1, close));
    if (tag !== null && SAFE_TAGS.has(tag.name)) {
      out += block.slice(at, close + 1);
      at = close + 1;
      continue;
    }
    out += escapeHtml(char);
    at += 1;
  }
  return out;
}

/** The block in the same flavour as the owner's text above it. */
function blockFor(owner: string, block: string): string {
  return looksLikeHtml(owner) ? htmlBlock(block) : block;
}

/** True when HTML text already ends a line, so the block can follow it directly. */
function endsHtmlLine(text: string): boolean {
  if (text.endsWith("\n")) return true;
  const open = text.lastIndexOf("<");
  if (open === -1 || !text.endsWith(">")) return false;
  const tag = parseTag(text.slice(open + 1, -1));
  return tag !== null && BREAK_TAGS.has(tag.name);
}

/** The owner's text with the block appended below it, a blank line between. */
function appendBlock(owner: string, block: string): string {
  if (!looksLikeHtml(owner)) return `${owner}${owner.endsWith("\n") ? "" : "\n\n"}${block}`;
  return `${owner}${endsHtmlLine(owner) ? "" : "<br><br>"}${htmlBlock(block)}`;
}

/**
 * What follows a legacy Healthy rendering, or null when the text is not one.
 *
 * The legacy rendering runs to the old footer line, then (on a ghost) a blank
 * line and the vanished line. Everything after that is the owner's.
 */
function legacyRemainder(text: string): string | null {
  const lines = scanLines(text);
  const footer = lines.findIndex((line) => lineText(text, line) === LEGACY_FOOTER);
  if (footer === -1) return null;
  let next = footer + 1;
  let vanishedSeen = false;
  while (next < lines.length) {
    const line = lines.at(next);
    if (line === undefined) break;
    const visible = lineText(text, line);
    if (visible === "") {
      next += 1;
      continue;
    }
    if (vanishedSeen || !visible.startsWith(VANISHED_PREFIX)) break;
    vanishedSeen = true;
    next += 1;
  }
  const rest = lines.at(next);
  return rest === undefined ? "" : text.slice(rest.cut);
}

/**
 * The description to write over `current`: the owner's text above the rule kept
 * verbatim, Healthy's block from the rule down. See the module comment for the
 * no-rule and legacy cases.
 */
export function mergeDescription(current: string | null, block: string): string {
  const text = current ?? "";
  if (text.trim() === "") return block;
  const rule = findRule(text);
  if (rule !== null) {
    const owner = text.slice(0, rule.cut);
    return `${owner}${blockFor(owner, block)}`;
  }
  const legacy = legacyRemainder(text);
  const owner = legacy ?? text;
  return plainText(owner.replaceAll("\n", " ")) === "" ? block : appendBlock(owner, block);
}

/**
 * True when `current` already carries `block` below its first rule line, give
 * or take HTML and blank lines. The owner's text above the line does not matter.
 */
export function carriesBlock(current: string | null, block: string): boolean {
  if (current === null) return false;
  const rule = findRule(current);
  if (rule === null) return false;
  const have = visibleLines(current.slice(rule.cut));
  const want = visibleLines(block);
  return have.length === want.length && have.every((line, index) => line === want.at(index));
}
