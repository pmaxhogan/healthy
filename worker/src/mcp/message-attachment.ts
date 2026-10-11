/**
 * `get_message_attachment`: one secure message's attached file, as the portal
 * pass stored it.
 *
 * The file was fetched and sealed by the sync (the portal's own id for it lasts
 * only as long as the session that listed it), so this reads storage and never
 * talks to a portal. What comes back depends on what the file is:
 *
 *  - text the repository already knows how to read (plain text, HTML, RTF --
 *    `convertDocument`, the same conversion `get_document_text` uses): the text;
 *  - an image a model can look at (PNG, JPEG, GIF, WebP): the item, plus the
 *    image itself as an MCP image content block;
 *  - anything else (a PDF, a TIFF scan): the item with the file's type and size
 *    and a `note` saying the content cannot be shown -- never a base64 blob, which
 *    a model would summarise confidently without having read.
 *
 * The item goes through `respond()` like every other: a `Communication` resource
 * rule removes it, and a field rule on `text` or `image` withholds that content
 * -- the image block is added only when the policy released the item's `image`.
 */

import { bytesToBase64 } from "../lib/base64.ts";
import { applyPolicy } from "../policy/filter.ts";

import { convertDocument, isConvertible } from "./document-text.ts";

import type { TaggedItem } from "./collect.ts";
import type { Messages } from "./message-items.ts";
import type { RawEntry } from "../policy/filter.ts";
import type { PolicyRules } from "../policy/rules.ts";

/** Image types a model can be handed as an image content block. */
const IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value: Json, key: string): unknown {
  return Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
}

/** The message item and attachment an id names, among the messages the caller may see. */
export function findAttachment(
  collected: Messages,
  attachmentId: string,
): { message: TaggedItem; attachment: Json; source: RawEntry | undefined } | null {
  for (const [index, message] of collected.items.entries()) {
    const attachments = own(message, "attachments");
    if (!Array.isArray(attachments)) continue;
    for (const attachment of attachments as unknown[]) {
      if (isRecord(attachment) && own(attachment, "id") === attachmentId) {
        return { message, attachment, source: collected.sources.at(index) };
      }
    }
  }
  return null;
}

/** The keys of `value` that are set, in `keys` order. */
function picked(value: Json, keys: readonly string[]): Json {
  const out: [string, unknown][] = [];
  for (const key of keys) {
    const found = own(value, key);
    if (found !== undefined) out.push([key, found]);
  }
  return Object.fromEntries(out);
}

/** The bare content type, lower-cased: `image/png; name=x` is `image/png`. */
function mediaType(contentType: unknown): string {
  return typeof contentType === "string"
    ? (contentType.split(";", 1)[0] ?? "").trim().toLowerCase()
    : "";
}

const NOTES: Readonly<Record<string, string>> = {
  failed:
    "The portal would not serve this file when the sync asked (see errorCode). " +
    "It is asked again on a portal pass a day later.",
  waiting_until_read:
    "Not fetched yet: its message is still unread in the patient portal, and " +
    "fetching the file could mark it read. It is fetched on the first hourly " +
    "portal pass after the message has been read there.",
  not_fetched:
    "Not fetched: either the portal pass has not reached it yet, or it is not a " +
    "file the portal serves (a clinical reference, or a link into another " +
    "organisation's portal).",
  unreadable:
    "Stored, but this file type cannot be returned as text or as an image here. " +
    "Its type and size are all this tool can report.",
  missing:
    "The file is recorded as stored but its content could not be read back. " +
    "It will not be fetched again on its own; report this.",
};

/** The one item `get_message_attachment` answers with, and the image bytes to add if any. */
export function attachmentItem(
  found: { message: TaggedItem; attachment: Json },
  bytes: Uint8Array | null,
): { item: TaggedItem; image: { data: string; mimeType: string } | null } {
  const { message, attachment } = found;
  const status = own(attachment, "status");
  const type = mediaType(own(attachment, "contentType"));
  const base: TaggedItem = {
    resourceType: own(message, "resourceType"),
    kind: "message_attachment",
    id: own(attachment, "id"),
    messageId: own(message, "id"),
    threadId: own(message, "threadId"),
    subject: own(message, "subject"),
    sent: own(message, "sent"),
    ...picked(attachment, ["name", "extension", "status", "errorCode", "contentType", "size"]),
    ...picked(message, ["source", "firstParty", "via", "healthSystem", "healthSystemId"]),
  };
  if (status !== "stored") {
    const note = typeof status === "string" ? NOTES[status] : undefined;
    return { item: { ...base, ...(note !== undefined && { note }) }, image: null };
  }
  if (bytes === null) return { item: { ...base, note: NOTES.missing }, image: null };
  if (isConvertible(type)) {
    const text = convertDocument(type, new TextDecoder().decode(bytes));
    if (text !== null) return { item: { ...base, chars: text.length, text }, image: null };
  }
  if (IMAGE_TYPES.has(type)) {
    return {
      item: { ...base, image: { contentType: type, returnedAs: "image content block" } },
      image: { data: bytesToBase64(bytes), mimeType: type },
    };
  }
  return { item: { ...base, note: NOTES.unreadable }, image: null };
}

/**
 * True when the policy releases the item's `image` for this caller -- the same
 * judgement `respond()` makes on the item itself, made here because the image
 * block travels beside the JSON rather than inside it.
 */
export function imageReleased(
  tool: string,
  rules: PolicyRules,
  item: TaggedItem,
  source: RawEntry | undefined,
): boolean {
  const filtered = applyPolicy({ tool, items: [item], sources: [source], rules });
  const [released] = filtered.items;
  return !filtered.denied && isRecord(released) && Object.hasOwn(released, "image");
}
