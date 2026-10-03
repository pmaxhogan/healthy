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
 * ModMed messages are not threaded by the API: each is its own row, and the
 * `messageLinks` it carries were empty in every row seen live, a reply included.
 * What does tie a reply to its message is the subject -- the practice's answer
 * comes back as `RE: <the owner's subject>` -- so messages from both folders
 * whose subjects match once reply/forward prefixes are stripped are one
 * conversation, oldest first (`conversationsOf`). A message with no subject
 * stands alone. Drafts are skipped: they are not messages
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
  if (!isRecord(row) || field(row, "isDraft") === true) return null;
  const sent = isoOf(field(row, "received")) ?? isoOf(field(row, "dateCreated"));
  if (sent === null) return null;
  const authorType = text(row, "authorType");
  const role = roleOf(authorType);
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
  const practitioners = folder === "sent" ? recipientsOf(row) : fromStaff;
  return {
    subject: text(row, "subject") ?? "",
    folder: "conversations",
    external: false,
    practitioners,
    messages: [message],
  };
}

/** Every usable row of one folder, drafts and unusable rows skipped. */
export function threadsOf(rows: readonly unknown[], folder: "inbox" | "sent"): PortalThread[] {
  const threads: PortalThread[] = [];
  for (const row of rows) {
    const thread = threadOf(row, folder);
    if (thread !== null) threads.push(thread);
  }
  return threads;
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
 * Merge one-message threads that belong to one conversation (see the module
 * comment): messages oldest first, the subject the opening message's, and the
 * care team every message named. Threads keep the order their first message
 * arrived in.
 */
export function conversationsOf(threads: readonly PortalThread[]): PortalThread[] {
  const byKey = new Map<string, PortalThread[]>();
  const alone: PortalThread[] = [];
  for (const thread of threads) {
    const key = conversationKey(thread.subject);
    if (key === "") {
      alone.push(thread);
      continue;
    }
    const group = byKey.get(key);
    if (group === undefined) byKey.set(key, [thread]);
    else group.push(thread);
  }
  const merged: PortalThread[] = [...alone];
  for (const group of byKey.values()) {
    const messages = byFirstSent(
      group.flatMap((thread) => thread.messages),
      (m) => m.sent,
    );
    const first = messages[0];
    const opening = group.find((thread) => first !== undefined && thread.messages.includes(first));
    if (opening === undefined) continue;
    // In the order the conversation reached them.
    const practitioners = uniquePractitioners(
      byFirstSent(group, (thread) => thread.messages[0]?.sent ?? ""),
    );
    merged.push({ ...opening, practitioners, messages });
  }
  return byFirstSent(merged, (thread) => thread.messages[0]?.sent ?? "");
}
