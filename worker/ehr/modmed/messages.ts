/**
 * ModMed secure messages (the portal's "intramail") -> the shared portal message model.
 *
 * ### What is read, and what never is
 *
 * Two lists, each paged to the end: the inbox (`/ema/ws/v3/intramail/inbox`) and
 * the sent folder (`/ema/ws/v3/intramail/sent`). Each row is a whole message --
 * subject, author, body, attachments and, for the inbox, the owner's own
 * read/flag state -- so no per-message call is needed.
 *
 * Nothing that changes anything in the portal is ever called. The app marks a
 * message read with a separate `PUT .../intramail/{id}/recipient/{r}/flags`
 * when it is opened; reading the list does not, and neither does this. The
 * per-message detail GET is not used either, because the list already carries
 * every field it would add.
 *
 * ### Shape
 *
 * ModMed messages are not threaded by the API: each is its own row. Two things
 * can tie a reply to the message it answers, and `messagesOf` uses them in
 * this order:
 *
 *  1. `messageLinks`, when a row carries any: the ids it names are joined to it.
 *     (Empty on every row seen live, a reply included, so this is read
 *     defensively: a number, a string, or an object with an id field.)
 *  2. Otherwise the subject. The practice's answer comes back as
 *     `RE: <the owner's subject>`, so a row whose subject carries a reply or
 *     forward prefix is joined to the latest *earlier* message from the *other*
 *     folder with the same subject once prefixes are stripped, sent within
 *     `REPLY_WINDOW_DAYS` before it. Nothing else is joined: two unrelated
 *     messages that happen to share a subject stay two conversations.
 *
 * A conversation's stored identity is its subject and first message
 * (`worker/db/repos/portal-messages.ts`). That is as stable as the lists are:
 * if the owner's original ages out of the sent folder while the reply is still
 * in the inbox, the reply is no longer joined to it and is stored as a
 * conversation of its own -- the original stays stored under the old one. The
 * API offers nothing more permanent to key on, so this is a known limit, not a
 * silent loss: every message is still stored exactly once. Drafts are skipped: they are not messages
 * anyone sent. Recipients are never kept -- a patient recipient is the owner,
 * named in full -- except a staff group's name on a sent message, which is the
 * care team it went to.
 *
 * Logs carry counts only.
 */

import { messageText } from "../mychart/message-text.ts";

import type {
  MessageAuthorRole,
  PortalMessage,
  PortalMessageAttachment,
  PortalThread,
} from "../mychart/messages.ts";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(record: Json, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function text(record: Json, key: string): string | undefined {
  const value = field(record, key);
  if (typeof value !== "string") return undefined;
  const trimmed = value.replaceAll(/\s+/gu, " ").trim();
  return trimmed === "" ? undefined : trimmed;
}

function idOf(record: Json, key = "id"): string | undefined {
  const value = field(record, key);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** `2026-10-01T15:04:05.000+0000` -> an ISO instant, or null. */
function isoOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const zone = /(?:Z|[+-]\d{2}:?\d{2})$/u.exec(value.trim())?.[0];
  if (zone === undefined) return null;
  const local = value.trim().slice(0, -zone.length);
  const offset = zone === "Z" ? "Z" : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  const ms = Date.parse(`${local}${offset}`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function roleOf(authorType: string | undefined): MessageAuthorRole {
  switch (authorType) {
    case "PATIENT": {
      return "patient";
    }
    case "STAFF":
    case "GROUP": {
      return "practitioner";
    }
    default: {
      return "system";
    }
  }
}

/** The extension of a file name, upper-cased the way MyChart reports one. */
function extensionOf(
  name: string | undefined,
  contentType: string | undefined,
): string | undefined {
  const fromName = name === undefined ? undefined : /\.([A-Za-z0-9]{1,8})$/u.exec(name)?.[1];
  if (fromName !== undefined) return fromName.toUpperCase();
  const subtype = contentType?.split("/", 2)[1]?.split(";", 1)[0]?.trim();
  return subtype === undefined || subtype === "" ? undefined : subtype.toUpperCase();
}

function attachmentsOf(row: Json): PortalMessageAttachment[] {
  const list = field(row, "fileAttachments");
  if (!Array.isArray(list)) return [];
  const out: PortalMessageAttachment[] = [];
  for (const item of list) {
    if (!isRecord(item) || field(item, "deleted") === true) continue;
    const id = idOf(item);
    const name = text(item, "fileName") ?? text(item, "name") ?? text(item, "title");
    const extension = extensionOf(name, text(item, "contentType") ?? text(item, "mimeType"));
    out.push({
      ...(name !== undefined && { name }),
      ...(extension !== undefined && { extension }),
      // The download needs only the attachment's id. The shared handle's other
      // two fields are MyChart's; empty here, and never stored either way.
      ...(id !== undefined && {
        handle: { dcsId: id, fileExtension: extension ?? "", organizationId: "" },
      }),
    });
  }
  return out;
}

/** Whether the owner has read an inbox message. Undefined when the row does not say. */
function unreadOf(row: Json, folder: "inbox" | "sent"): boolean | undefined {
  if (folder === "sent") return false;
  const flags = field(row, "currentRecipientFlags");
  if (!isRecord(flags)) return undefined;
  const read = field(flags, "messageRead");
  return typeof read === "boolean" ? !read : undefined;
}

/** The care team a sent message went to: staff group or staff names only, never a patient. */
function recipientsOf(row: Json): { name: string }[] {
  const to = field(row, "to");
  if (!Array.isArray(to)) return [];
  const names: { name: string }[] = [];
  for (const recipient of to) {
    if (!isRecord(recipient)) continue;
    const type = text(recipient, "type");
    if (type === "PATIENT") continue;
    const name =
      text(recipient, "groupName") ??
      text(recipient, "name") ??
      ([text(recipient, "firstName"), text(recipient, "lastName")].filter(Boolean).join(" ") ||
        undefined);
    if (name !== undefined) names.push({ name });
  }
  return names;
}

/** One list row as a one-message conversation, or null for a draft or an unusable row. */
export function threadOf(row: unknown, folder: "inbox" | "sent"): PortalThread | null {
  return isRecord(row) ? (itemOf(row, folder)?.thread ?? null) : null;
}

/** One parsed row, with what threading needs to know about it. */
interface Item {
  thread: PortalThread;
  folder: "inbox" | "sent";
  id: string | undefined;
  links: string[];
  sentMs: number;
  key: string;
  isReply: boolean;
}

/** Ids named in a row's `messageLinks`, whatever shape an entry takes. */
function linksOf(row: Json): string[] {
  const links = field(row, "messageLinks");
  if (!Array.isArray(links)) return [];
  const ids: string[] = [];
  for (const link of links) {
    if (typeof link === "number" || typeof link === "string") {
      ids.push(String(link));
      continue;
    }
    if (!isRecord(link)) continue;
    const id =
      idOf(link, "linkedMessageId") ??
      idOf(link, "messageId") ??
      idOf(link, "relatedMessageId") ??
      idOf(link, "id");
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

const REPLY_PREFIX = /^\s*(?:re|fw|fwd)\s*:/iu;

function itemOf(row: Json, folder: "inbox" | "sent"): Item | null {
  if (field(row, "isDraft") === true) return null;
  const sent = isoOf(field(row, "received")) ?? isoOf(field(row, "dateCreated"));
  if (sent === null) return null;
  const role = roleOf(text(row, "authorType"));
  const author = text(row, "authorName");
  const rawBody = field(row, "messageBody");
  const unread = unreadOf(row, folder);
  const message: PortalMessage = {
    sent,
    role,
    ...(author !== undefined && { author }),
    body: typeof rawBody === "string" ? messageText(rawBody) : "",
    attachments: attachmentsOf(row),
    ...(unread !== undefined && { unread }),
  };
  const fromStaff = role === "practitioner" && author !== undefined ? [{ name: author }] : [];
  const subject = text(row, "subject") ?? "";
  return {
    thread: {
      subject,
      folder: "conversations",
      external: false,
      practitioners: folder === "sent" ? recipientsOf(row) : fromStaff,
      messages: [message],
    },
    folder,
    id: idOf(row),
    links: linksOf(row),
    sentMs: Date.parse(sent),
    key: conversationKey(subject),
    isReply: REPLY_PREFIX.test(subject),
  };
}

/** Rows parsed, and how many were dropped for want of a usable date. */
function parseRows(
  rows: readonly unknown[],
  folder: "inbox" | "sent",
): { items: Item[]; undated: number } {
  const items: Item[] = [];
  let undated = 0;
  for (const row of rows) {
    if (!isRecord(row) || field(row, "isDraft") === true) continue;
    const item = itemOf(row, folder);
    if (item === null) undated += 1;
    else items.push(item);
  }
  return { items, undated };
}

/** Every usable row of one folder as one-message threads. Not joined: see `messagesOf`. */
export function threadsOf(rows: readonly unknown[], folder: "inbox" | "sent"): PortalThread[] {
  return parseRows(rows, folder).items.map((item) => item.thread);
}

/** How far back a subject-matched reply may reach for the message it answers. */
const REPLY_WINDOW_DAYS = 60;

/** Union-find over item indexes, for joining replies to what they answer. */
function makeGroups(size: number): {
  join: (a: number, b: number) => void;
  root: (a: number) => number;
} {
  const parent = Array.from({ length: size }, (_, index) => index);
  const root = (a: number): number => {
    let node = a;
    while (parent[node] !== node) node = parent[node] ?? node;
    return node;
  };
  return {
    root,
    join: (a, b) => {
      const ra = root(a);
      const rb = root(b);
      if (ra !== rb) parent[rb] = ra;
    },
  };
}

/** The earlier message from the other folder a subject-only reply answers, if any. */
function answeredBy(items: readonly Item[], reply: Item): number | undefined {
  if (!reply.isReply || reply.key === "") return undefined;
  const window = REPLY_WINDOW_DAYS * 86_400_000;
  let best: number | undefined;
  let bestMs = -Infinity;
  for (const [index, candidate] of items.entries()) {
    const eligible =
      candidate !== reply && candidate.folder !== reply.folder && candidate.key === reply.key;
    const gap = reply.sentMs - candidate.sentMs;
    if (!eligible || gap <= 0 || gap > window || candidate.sentMs <= bestMs) continue;
    best = index;
    bestMs = candidate.sentMs;
  }
  return best;
}

export interface ParsedMessages {
  threads: PortalThread[];
  /** Rows dropped because no usable date could be read from them. */
  undated: number;
}

/** Join every item to what its links or its reply subject name. */
function joinReplies(items: readonly Item[], groups: ReturnType<typeof makeGroups>): void {
  const byId = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    if (item.id !== undefined) byId.set(`${item.folder}:${item.id}`, index);
  }
  for (const [index, item] of items.entries()) {
    const targets =
      item.links.length > 0 ? linkedIndexes(item.links, byId) : [answeredBy(items, item)];
    for (const target of targets) if (target !== undefined) groups.join(target, index);
  }
}

/** The items a row's `messageLinks` name, by id, in either folder. */
function linkedIndexes(
  links: readonly string[],
  byId: ReadonlyMap<string, number>,
): (number | undefined)[] {
  return links.map((link) => byId.get(`inbox:${link}`) ?? byId.get(`sent:${link}`));
}

/**
 * Both folders' rows as conversations: replies joined to what they answer (see
 * the module comment), messages oldest first, conversations in the order they
 * started.
 */
export function messagesOf(
  inboxRows: readonly unknown[],
  sentRows: readonly unknown[],
): ParsedMessages {
  const inbox = parseRows(inboxRows, "inbox");
  const sent = parseRows(sentRows, "sent");
  const items = [...inbox.items, ...sent.items];
  const groups = makeGroups(items.length);
  joinReplies(items, groups);
  const grouped = new Map<number, PortalThread[]>();
  for (const [index, item] of items.entries()) {
    const root = groups.root(index);
    const group = grouped.get(root);
    if (group === undefined) grouped.set(root, [item.thread]);
    else group.push(item.thread);
  }
  const threads = Array.from(grouped.values(), (group) => mergeGroup(group));
  return {
    threads: byFirstSent(threads, (thread) => thread.messages[0]?.sent ?? ""),
    undated: inbox.undated + sent.undated,
  };
}

/** A sorted copy, oldest first, by an ISO instant. */
function byFirstSent<T>(items: readonly T[], instant: (item: T) => string): T[] {
  // eslint-disable-next-line unicorn/no-array-sort -- Array#toSorted is ES2023 and the Worker compiles against ES2022; this sorts a fresh copy.
  return [...items].sort((a, b) => instant(a).localeCompare(instant(b)));
}

/** Every care-team name a group of threads mentions, once each, in order. */
function uniquePractitioners(group: readonly PortalThread[]): { name: string }[] {
  const seen = new Set<string>();
  const out: { name: string }[] = [];
  const all = group.flatMap((thread) => thread.practitioners);
  for (const practitioner of all) {
    if (seen.has(practitioner.name)) continue;
    seen.add(practitioner.name);
    out.push(practitioner);
  }
  return out;
}

/** A subject with any run of leading `RE:` / `FW:` / `Fwd:` removed, for matching. */
export function conversationKey(subject: string): string {
  return subject
    .replace(/^\s*(?:(?:re|fw|fwd)\s*:\s*)+/iu, "")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/**
 * One conversation from the one-message threads that make it up: messages
 * oldest first, the subject the opening message's, and the care team every
 * message named, in the order the conversation reached them.
 */
function mergeGroup(group: readonly PortalThread[]): PortalThread {
  const ordered = byFirstSent(group, (thread) => thread.messages[0]?.sent ?? "");
  const opening = ordered[0];
  if (opening === undefined) throw new Error("an empty conversation group");
  const messages = byFirstSent(
    ordered.flatMap((thread) => thread.messages),
    (message) => message.sent,
  );
  return { ...opening, practitioners: uniquePractitioners(ordered), messages };
}
