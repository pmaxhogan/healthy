/**
 * Secure messages grouped into conversations: what `get_messages` and
 * `get_message_thread` actually answer with.
 *
 * `message-items.ts` hands `respond()` one item per message, and the exposure
 * policy judges each of those on its own -- above all the sender's name, by who
 * the sender is, so a rule withholding the patient's name takes the patient's
 * name and nothing else. Only then, in `respond()`'s `reshape` step, are the
 * policy-filtered messages grouped here into one item per conversation. Nothing a
 * thread carries (a participant, a preview, a count, a date) can therefore hold a
 * value the policy withheld from the message it came from; and `respond()` runs
 * the policy over the thread items once more, so a rule written against a
 * thread's own fields (`lastMessage.preview`, `messages[].body`) reaches them too.
 *
 * A conversation is the messages that share a `threadId` AND a health system.
 * The id is the same whichever portal a conversation was read through, and
 * after the cross-portal dedupe a conversation is almost always answered from
 * one health system; when its messages come from two (one portal has a reply the
 * other has not listed yet), it is answered as one item per health system, so
 * each item is still judged under its own health system's rules.
 *
 * Pure: no bindings, no I/O.
 */

import type { ReshapeRow, Reshaped } from "./respond.ts";

/** How many characters of the newest message a thread summary previews. */
export const PREVIEW_CHARS = 160;

/** The kinds of item this module builds. */
const SUMMARY_KIND = "message_thread";
const DETAIL_KIND = "message_thread_detail";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value: Json, key: string): unknown {
  return Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
}

function text(value: Json, key: string): string | undefined {
  const found = own(value, key);
  return typeof found === "string" ? found : undefined;
}

function records(value: Json, key: string): Json[] {
  const found = own(value, key);
  return Array.isArray(found) ? (found as unknown[]).filter((entry) => isRecord(entry)) : [];
}

/** What the grouping knows about one policy-filtered message. */
interface Message {
  item: Json;
  /** `sent` as ms, or NaN when a rule withheld it. */
  at: number;
}

interface Group {
  key: string;
  messages: Message[];
}

/** Oldest first; a message whose time was withheld sorts last. Ties by id. */
function byTime(a: Message, b: Message): number {
  const left = Number.isNaN(a.at) ? Infinity : a.at;
  const right = Number.isNaN(b.at) ? Infinity : b.at;
  if (left !== right) return left < right ? -1 : 1;
  const idA = text(a.item, "id") ?? "";
  const idB = text(b.item, "id") ?? "";
  return idA < idB ? -1 : Number(idA > idB);
}

/**
 * Group policy-filtered message items by conversation.
 *
 * A message whose `threadId` a rule withheld cannot be placed in its
 * conversation, and is answered as a conversation of its own rather than
 * dropped.
 */
function groupMessages(rows: readonly ReshapeRow[]): Group[] {
  const groups = new Map<string, Group>();
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row.item)) continue;
    const threadId = text(row.item, "threadId");
    const healthSystemId = text(row.item, "healthSystemId") ?? "";
    const key =
      threadId === undefined
        ? `\u{0}unthreaded\u{0}${String(index)}`
        : `${healthSystemId}\u{0}${threadId}`;
    const sent = text(row.item, "sent");
    const message: Message = { item: row.item, at: sent === undefined ? NaN : Date.parse(sent) };
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { key, messages: [message] });
    else group.messages.push(message);
  }
  const out: Group[] = [];
  for (const group of groups.values()) {
    group.messages.sort(byTime);
    out.push(group);
  }
  return out;
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Whitespace collapsed; the first {@link PREVIEW_CHARS} characters, counted as
 * a reader sees them (grapheme clusters), so a cut never splits one.
 */
export function previewOf(body: string): { preview: string; previewTruncated: boolean } {
  const flat = body.replaceAll(/\s+/gu, " ").trim();
  const kept: string[] = [];
  for (const { segment } of GRAPHEMES.segment(flat)) {
    if (kept.length === PREVIEW_CHARS) {
      return { preview: `${kept.join("").trimEnd()}…`, previewTruncated: true };
    }
    kept.push(segment);
  }
  return { preview: flat, previewTruncated: false };
}

/** A sender as the message item carries it (the policy may have removed the name). */
function senderOf(item: Json): Json | undefined {
  const from = own(item, "from");
  return isRecord(from) ? { ...from } : undefined;
}

/** Every distinct sender, in the order they first wrote. */
function participantsOf(messages: readonly Message[]): Json[] {
  const seen = new Set<string>();
  const out: Json[] = [];
  for (const { item } of messages) {
    const from = senderOf(item);
    if (from === undefined) continue;
    const key = JSON.stringify([text(from, "role") ?? "", text(from, "name") ?? ""]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(from);
  }
  return out;
}

/** The care team, merged across the conversation's messages. */
function practitionersOf(messages: readonly Message[]): Json[] | undefined {
  let present = false;
  const names = new Set<string>();
  for (const { item } of messages) {
    if (!Object.hasOwn(item, "practitioners")) continue;
    present = true;
    for (const practitioner of records(item, "practitioners")) {
      const name = text(practitioner, "name");
      if (name !== undefined) names.add(name);
    }
  }
  return present ? [...names].map((name) => ({ name })) : undefined;
}

/** An instant as ISO, or undefined when there is none (no message's time was released). */
function isoOf(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

/** A copy of `value` without the keys that are undefined. */
function defined(value: Record<string, unknown>): Json {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

/** What every thread item carries, summary or detail. */
function threadFields(group: Group): Json {
  const { messages } = group;
  const latest = messages.at(-1)?.item ?? {};
  // Oldest first already (`byTime`), a withheld time last: the ends are the range.
  const times = messages.map((message) => message.at).filter((at) => !Number.isNaN(at));
  let attachments = 0;
  let unread = 0;
  let unreadKnown = false;
  for (const { item } of messages) {
    attachments += records(item, "attachments").length;
    const flag = own(item, "unread");
    if (typeof flag !== "boolean") continue;
    unreadKnown = true;
    if (flag) unread += 1;
  }
  const everyGone =
    messages.length > 0 && messages.every(({ item }) => own(item, "noLongerListed") === true);
  return defined({
    resourceType: own(latest, "resourceType"),
    threadId: own(latest, "threadId"),
    subject: own(latest, "subject"),
    folder: own(latest, "folder"),
    firstMessageAt: isoOf(times.at(0)),
    lastMessageAt: isoOf(times.at(-1)),
    messageCount: messages.length,
    unreadCount: unreadKnown ? unread : undefined,
    attachmentCount: attachments,
    hasAttachments: attachments > 0,
    practitioners: practitionersOf(messages),
    participants: participantsOf(messages),
    organization: own(latest, "organization"),
    source: own(latest, "source"),
    firstParty: own(latest, "firstParty"),
    via: own(latest, "via"),
    noLongerListed: everyGone || undefined,
    healthSystem: own(latest, "healthSystem"),
    healthSystemId: own(latest, "healthSystemId"),
  });
}

/** The newest message, previewed: what a thread list shows under its subject. */
function lastMessageOf(group: Group): Json | undefined {
  const latest = group.messages.at(-1)?.item;
  if (latest === undefined) return undefined;
  const body = text(latest, "body");
  return defined({
    id: own(latest, "id"),
    sent: own(latest, "sent"),
    direction: own(latest, "direction"),
    from: senderOf(latest),
    ...(body !== undefined && previewOf(body)),
  });
}

/** One message as a thread's `messages[]` carries it: everything but the thread's own fields. */
function messageEntry(item: Json): Json {
  return defined({
    id: own(item, "id"),
    sent: own(item, "sent"),
    direction: own(item, "direction"),
    from: senderOf(item),
    unread: own(item, "unread"),
    body: own(item, "body"),
    attachments: Object.hasOwn(item, "attachments") ? records(item, "attachments") : undefined,
    noLongerListed: own(item, "noLongerListed"),
  });
}

/** Newest conversation first; one whose time was withheld sorts last. */
function byLatest(a: Json, b: Json): number {
  const left = Date.parse(text(a, "lastMessageAt") ?? "");
  const right = Date.parse(text(b, "lastMessageAt") ?? "");
  const l = Number.isNaN(left) ? -Infinity : left;
  const r = Number.isNaN(right) ? -Infinity : right;
  if (l !== r) return l > r ? -1 : 1;
  const idA = `${text(a, "threadId") ?? ""}\u{0}${text(a, "healthSystemId") ?? ""}`;
  const idB = `${text(b, "threadId") ?? ""}\u{0}${text(b, "healthSystemId") ?? ""}`;
  return idA < idB ? -1 : Number(idA > idB);
}

/** Lower-cased, whitespace collapsed: what a search compares. */
function folded(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim().toLowerCase();
}

/** True when the conversation's subject or any message's text contains `needle`. */
function mentions(group: Group, needle: string): boolean {
  return group.messages.some(({ item }) =>
    ["subject", "body"].some((key) => folded(text(item, key) ?? "").includes(needle)),
  );
}

export interface ThreadView {
  /** `summary`: one item per conversation with a preview. `detail`: every message in full. */
  detail: boolean;
  /** Case-insensitive text every kept conversation's subject or messages must contain. */
  search?: string | undefined;
}

/**
 * The reshape both message tools hand `respond()`: group, search, summarise.
 *
 * `total` is the conversations answered; the envelope adds `messages`, how many
 * messages they hold.
 */
export function threadsReshape(view: ThreadView): (rows: readonly ReshapeRow[]) => Reshaped {
  return (rows) => {
    let groups = groupMessages(rows);
    const needle = view.search === undefined ? "" : folded(view.search);
    if (needle !== "") groups = groups.filter((group) => mentions(group, needle));
    const items = groups.map((group) =>
      view.detail
        ? {
            ...threadFields(group),
            kind: DETAIL_KIND,
            messages: group.messages.map((message) => messageEntry(message.item)),
          }
        : defined({
            ...threadFields(group),
            kind: SUMMARY_KIND,
            lastMessage: lastMessageOf(group),
          }),
    );
    items.sort(byLatest);
    return {
      items,
      raw: items.map(() => []),
      total: items.length,
      warnings: [],
      envelope: { messages: groups.reduce((sum, group) => sum + group.messages.length, 0) },
    };
  };
}
