/**
 * Small text clean-ups shared by the calendar mapping, the portal parser and the
 * FHIR normalizers.
 */

/**
 * Unicode bidirectional-formatting controls: the embeddings and overrides
 * (U+202A-U+202E), the isolates (U+2066-U+2069) and the implicit marks (U+200E,
 * U+200F, U+061C).
 *
 * Invisible, and meaningless outside the page that rendered them -- but a portal
 * wraps a phone number in U+202A ... U+202C so it lays out left-to-right in a
 * right-to-left page, and copied into a calendar event or an MCP answer they make
 * the number look corrupt or fail to dial.
 */
const BIDI_CONTROLS = /[\u{61C}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;

/**
 * A phone number as a person would type it: bidi controls removed, surrounding
 * whitespace trimmed. Undefined when nothing is left. Nothing else is changed --
 * the number's own formatting is the health system's, and reformatting it would
 * guess at a country.
 */
export function cleanPhone(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.replaceAll(BIDI_CONTROLS, "").trim();
  return cleaned === "" ? undefined : cleaned;
}
