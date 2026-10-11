/**
 * The parts of one visit's details page (`Visits/VisitDetails?csn=<token>`) the
 * visits list does not carry: the earlier-appointment wait list, the
 * department's directions, and the visit's own instructions.
 *
 * The page is server-rendered HTML, and a live capture found no JSON endpoint
 * behind any of the three: the wait-list widget's own script only ever *posts*
 * a change (`Scheduling/AutoWaitList/AddAppointmentToWaitList`), and its
 * `Index` endpoint answered an empty body. So the page is read, and only as
 * text: the markers below are the page's own class names and ids, sliced out
 * of the string, and flattened by `messageText` exactly like a message body --
 * nothing of the markup is kept.
 *
 *   - **Wait list.** A `waitlist` block exists only when the visit offers one.
 *     Its link (`id="updatewaitlist"`) carries `data-add="1"` when following it
 *     would *add* the patient -- not enrolled -- and `data-add="0"` when it would
 *     remove them. Any other value is the null "offered, state unknown".
 *   - **Directions.** The `departmentdirections` block's content. Every
 *     paragraph is kept here, the health system's boilerplate included; which
 *     paragraphs are boilerplate is only knowable across many visits, and
 *     `worker/src/sync/portal-directions.ts` decides that.
 *   - **Visit instructions.** The other `visitinstructionscontent` block, the one
 *     that is not inside the directions.
 *
 * Read-only: the page is only ever fetched with GET, and nothing on it is
 * followed or submitted.
 */

import { messageText } from "./message-text.ts";

import type { AppointmentWaitlist } from "../../fhir/normalize/types.ts";

export interface VisitDetails {
  /** Null: the page offers no wait list for this visit. */
  waitlist: AppointmentWaitlist | null;
  directions?: string;
  visitInstructions?: string;
}

/** Where the directions block starts. */
const DIRECTIONS_OPEN = /<div\s+class="departmentdirections"\s*>/iu;
/**
 * Where the visit instructions block starts: a `visitinformation` wrapper whose
 * first child is the content block (the directions' one is wrapped differently).
 */
const INSTRUCTIONS_OPEN =
  /<div\s+class="visitinformation"\s*>\s*<div\s+class="visitinformation visitinstructionscontent"\s*>/iu;
/** The text container inside either block. */
const CONTENT_OPEN = /<div\s+class="instructionContent"[^<>]*>/iu;
/** What follows the text in either block: the page's own "read more" toggle. */
const CONTENT_END = /<div\s+class="readmore/iu;

const WAITLIST_BLOCK = /<div\s+class="waitlist"\s*>/iu;
const WAITLIST_LINK = /<a\b[^<>]*\bid="updatewaitlist"[^<>]*>/iu;
const DATA_ADD = /\bdata-add="([^"]*)"/iu;

/** The flattened text of the content block starting at or after `from`, or undefined. */
function contentAfter(html: string, from: number): string | undefined {
  const rest = html.slice(from);
  const open = CONTENT_OPEN.exec(rest);
  if (open === null) return undefined;
  const body = rest.slice(open.index + open[0].length);
  const end = CONTENT_END.exec(body);
  const text = messageText(end === null ? body : body.slice(0, end.index));
  return text === "" ? undefined : text;
}

function waitlistOf(html: string): AppointmentWaitlist | null {
  const block = WAITLIST_BLOCK.exec(html);
  if (block === null) return null;
  const link = WAITLIST_LINK.exec(html.slice(block.index));
  const add = link === null ? undefined : DATA_ADD.exec(link[0])?.[1];
  const states = new Map<string | undefined, boolean>([
    ["1", false],
    ["0", true],
  ]);
  return { enrolled: states.get(add) ?? null };
}

/** Parse one details page. Never throws: a page without a section simply lacks it. */
export function parseVisitDetails(html: string): VisitDetails {
  const directionsAt = DIRECTIONS_OPEN.exec(html);
  const instructionsAt = INSTRUCTIONS_OPEN.exec(html);
  const directions = directionsAt === null ? undefined : contentAfter(html, directionsAt.index);
  const visitInstructions =
    instructionsAt === null ? undefined : contentAfter(html, instructionsAt.index);
  return {
    waitlist: waitlistOf(html),
    ...(directions !== undefined && { directions }),
    ...(visitInstructions !== undefined && { visitInstructions }),
  };
}
