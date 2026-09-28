/**
 * The Message Center: every conversation in every folder, every message in each.
 *
 * Both portal flavours serve the same MyChart "communication center" JSON API once
 * signed in -- only the mount differs -- so this is one crawler. It is pure: the
 * caller hands it a `post` that has already dealt with the session, the
 * antiforgery token and the "200 carrying HTML" failure (`client.ts`), and gets
 * back parsed threads. Nothing here logs, stores or knows a health system.
 *
 * ### What "everything" takes (all confirmed from a capture)
 *
 *  - **Every folder.** `GetConversationList` is per folder `tag`
 *    (`MESSAGE_FOLDERS`); the folders are disjoint.
 *  - **Every organisation.** A chart linked to other organisations shows their
 *    conversations too, but only for the organisations named in
 *    `externalLoadParams` -- leave one out and its threads are silently absent. So
 *    `GetOrganizations` is read first and every non-local one is asked for.
 *  - **Every page.** Each organisation pages on its own (50 at a time): the
 *    summary it sends back says `hasMoreConversations`, and the next page is asked
 *    for from its `oldestLoadedInstantISO`. Paging ends when no organisation has
 *    more. There is no page cap. A page that claims more but adds nothing new is
 *    an error rather than a loop or a silent stop.
 *  - **Every message.** A listed conversation carries its newest five messages;
 *    `GetConversationMessages` pages older ones, five at a time, from the oldest
 *    loaded instant, until `hasMoreMessages` is false. Never `maxReadMessages: 0`,
 *    which answers with nothing.
 *
 * `GetConversationDetails` is never called: it marks a conversation read, and the
 * list plus `GetConversationMessages` already reproduce every thread's
 * `totalMessages` exactly.
 *
 * ### Identifiers
 *
 * The portal's ids (`hthId`, `wmgId`, organisation and author keys) are opaque
 * `WP-...` tokens with no evidence that they survive a new session. They are used
 * only within one crawl -- to dedupe and to page -- and never leave this module.
 * The sync keys what it stores on content instead.
 */

import { AppError } from "../../lib/errors.ts";

import { messageText } from "./message-text.ts";
import { MESSAGE_FOLDERS, PAGE_NONCE_KEY, PATHS } from "./wire.ts";

/** Which Message Center folder a conversation sits in. */
export type MessageFolder = (typeof MESSAGE_FOLDERS)[number]["folder"];

/**
 * Who wrote a message. A clinician (or any staff member) is a `practitioner`;
 * the patient is `patient`; someone else signed in to the chart (a proxy) is
 * `proxy`; a sender with no person behind it -- an automated notice -- is
 * `system`.
 */
export type MessageAuthorRole = "patient" | "proxy" | "practitioner" | "system";

/** Metadata of one attachment. The file itself is never fetched. */
interface PortalMessageAttachment {
  name?: string;
  /** File extension as the portal reports it, e.g. `PDF`. */
  extension?: string;
}

export interface PortalMessage {
  /** ISO instant the message was delivered. */
  sent: string;
  role: MessageAuthorRole;
  /** The author's display name, when the portal names one. */
  author?: string;
  /** Plain text, flattened from the portal's HTML (`message-text.ts`). */
  body: string;
  attachments: PortalMessageAttachment[];
}

export interface PortalThread {
  subject: string;
  folder: MessageFolder;
  /**
   * True when the conversation belongs to another organisation linked to this
   * chart (a Happy Together copy), false when it is this portal's own.
   */
  external: boolean;
  /** The owning organisation's name, for an external conversation. */
  organization?: string;
  /** The portal's numeric message type, as a string. Opaque; kept for filtering. */
  messageType?: string;
  /** The care-team members the conversation is addressed to or from. */
  practitioners: { name: string }[];
  /** Oldest first. Never empty. */
  messages: PortalMessage[];
}

export interface PortalMessagesResult {
  threads: PortalThread[];
  /**
   * False when an organisation that was asked for sent no summary back, so its
   * conversations may be missing. The caller must not treat absence as deletion.
   */
  complete: boolean;
  /** List and message pages read, for the log line. */
  pages: number;
}

/** POST one Message Center endpoint and hand back its parsed JSON. */
type MessageCenterPost = (path: string, label: string, body: unknown) => Promise<unknown>;

export interface LoadMessagesDeps {
  post: MessageCenterPost;
  /** 32 hex characters per request. Injected so a test can pin it. */
  nonce: () => string;
}

// --- reading untrusted JSON ----------------------------------------------------

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One own property, or undefined. Never an inherited one. */
function own(value: unknown, key: string): unknown {
  return isRecord(value) && Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
}

function str(value: unknown, key: string): string {
  const found = own(value, key);
  return typeof found === "string" ? found : "";
}

function bool(value: unknown, key: string): boolean {
  return own(value, key) === true;
}

function records(value: unknown, key: string): Json[] {
  const found = own(value, key);
  return Array.isArray(found) ? (found as unknown[]).filter((entry) => isRecord(entry)) : [];
}

/** An id-keyed object as a Map, so a portal key never touches a prototype. */
function keyed(value: unknown, key: string): Map<string, unknown> {
  const found = own(value, key);
  return new Map<string, unknown>(isRecord(found) ? Object.entries(found) : []);
}

function parseFailure(message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError("portal_parse_failed", message, { endpoint: "MessageCenter", ...details });
}

// --- paging ---------------------------------------------------------------------

interface LoadParams {
  loadStartInstantISO: string;
  loadEndInstantISO: string;
  pagingInfo: number;
}

/** What the page's own script sends for a first page. */
const FIRST_PAGE: LoadParams = { loadStartInstantISO: "", loadEndInstantISO: "", pagingInfo: 1 };

/** The mailboxes an external organisation's summary may report on. */
const MAILBOXES = ["communicationCenter", "inbox", "outbox"] as const;

/** The next page after one summary, or undefined when that list is done. */
function nextParams(summary: unknown): LoadParams | undefined {
  if (!bool(summary, "hasMoreConversations")) return undefined;
  const oldest = str(summary, "oldestLoadedInstantISO");
  const paging = own(summary, "pagingInfo");
  return {
    loadStartInstantISO: oldest,
    loadEndInstantISO: "",
    pagingInfo: typeof paging === "number" ? paging : 1,
  };
}

/** The external-organisation parameters for the next page: only the lists that have more. */
function nextExternal(page: unknown): Map<string, Map<string, LoadParams>> {
  const next = new Map<string, Map<string, LoadParams>>();
  for (const [key, summary] of keyed(page, "externalSummaries")) {
    const orgId = str(summary, "organizationId") || key;
    const boxes = new Map<string, LoadParams>();
    for (const box of MAILBOXES) {
      const params = nextParams(own(summary, box));
      if (params !== undefined) boxes.set(box, params);
    }
    if (boxes.size > 0) next.set(orgId, boxes);
  }
  return next;
}

function externalBody(external: ReadonlyMap<string, ReadonlyMap<string, LoadParams>>): Json {
  return Object.fromEntries(
    [...external].map(([orgId, boxes]) => [orgId, Object.fromEntries(boxes)]),
  );
}

// --- the crawl ------------------------------------------------------------------

interface Organization {
  name: string;
  local: boolean;
}

/** Everything one crawl collects before it is turned into threads. */
interface Crawl {
  organizations: Map<string, Organization>;
  /** Staff by author key, merged from every page. */
  users: Map<string, unknown>;
  /** People signed in to the chart (the patient, a proxy), by author key. */
  viewers: Map<string, unknown>;
  /** Conversations by `<organizationId>\0<hthId>`, each with the folder it came from. */
  conversations: Map<string, { conversation: Json; folder: MessageFolder }>;
  complete: boolean;
  pages: number;
}

async function readOrganizations(deps: LoadMessagesDeps): Promise<Map<string, Organization>> {
  const answer = await deps.post(PATHS.conversationOrganizations, "GetOrganizations", {});
  const out = new Map<string, Organization>();
  for (const [key, org] of keyed(answer, "organizations")) {
    const id = str(org, "organizationId") || key;
    out.set(id, { name: str(org, "organizationName"), local: bool(org, "isLocal") });
  }
  return out;
}

function mergeInto(target: Map<string, unknown>, page: unknown, key: string): void {
  for (const [id, value] of keyed(page, key)) target.set(id, value);
}

/**
 * True when a first page summarised every external organisation it was asked
 * for. One that sends no summary back cannot be proven complete: whatever it
 * holds may simply not have arrived.
 */
function summarisesAll(page: unknown, externalIds: readonly string[]): boolean {
  const summarised = new Set(
    [...keyed(page, "externalSummaries")].map(
      ([key, summary]) => str(summary, "organizationId") || key,
    ),
  );
  return externalIds.every((id) => summarised.has(id));
}

/** Keep one page's conversations, each once; how many were new. */
function addConversations(crawl: Crawl, page: unknown, folder: MessageFolder): number {
  let added = 0;
  for (const conversation of records(page, "conversations")) {
    const key = `${str(conversation, "organizationId")}\u{0}${str(conversation, "hthId")}`;
    // The server re-sends the local first page on every later page (once local
    // paging is done it is simply the default), so a repeat is expected.
    if (crawl.conversations.has(key)) continue;
    crawl.conversations.set(key, { conversation, folder });
    added += 1;
  }
  return added;
}

/** Every page of one folder, every organisation, to the end. */
async function crawlFolder(
  deps: LoadMessagesDeps,
  crawl: Crawl,
  tag: number,
  folder: MessageFolder,
): Promise<void> {
  const externalIds = [...crawl.organizations].filter(([, org]) => !org.local).map(([id]) => id);
  let local: LoadParams | undefined = FIRST_PAGE;
  let external = new Map(
    externalIds.map((id) => [id, new Map([["communicationCenter", FIRST_PAGE]])]),
  );
  let first = true;
  while (first || local !== undefined || external.size > 0) {
    const page = await deps.post(PATHS.conversationList, "GetConversationList", {
      tag,
      localLoadParams: local ?? null,
      externalLoadParams: externalBody(external),
      searchQuery: "",
      [PAGE_NONCE_KEY]: deps.nonce(),
    });
    crawl.pages += 1;
    if (first && !summarisesAll(page, externalIds)) crawl.complete = false;
    first = false;
    mergeInto(crawl.users, page, "users");
    mergeInto(crawl.viewers, page, "viewers");
    const added = addConversations(crawl, page, folder);
    const nextLocal: LoadParams | undefined =
      local === undefined ? undefined : nextParams(own(page, "localSummary"));
    const nextExt = nextExternal(page);
    if (added === 0 && (nextLocal !== undefined || nextExt.size > 0)) {
      throw parseFailure("a conversation page claimed more but added nothing", { tag });
    }
    local = nextLocal;
    external = nextExt;
  }
}

/** The earliest delivery instant among some messages: where the next older page starts. */
function oldestInstant(messages: readonly Json[]): string {
  let oldest = "";
  for (const message of messages) {
    const instant = str(message, "deliveryInstantISO");
    if (instant !== "" && (oldest === "" || instant < oldest)) oldest = instant;
  }
  return oldest;
}

/** Every message of one conversation: the listed ones, then older pages to the end. */
async function crawlMessages(
  deps: LoadMessagesDeps,
  crawl: Crawl,
  conversation: Json,
): Promise<{ messages: Json[]; overrides: Map<string, unknown> }> {
  const messages = records(conversation, "messages");
  const overrides = keyed(conversation, "userOverrideNames");
  const seen = new Set(messages.map((message) => str(message, "wmgId")));
  let more = bool(conversation, "hasMoreMessages");
  while (more) {
    const oldest = oldestInstant(messages);
    const page = await deps.post(PATHS.conversationMessages, "GetConversationMessages", {
      id: str(conversation, "hthId"),
      organizationId: str(conversation, "organizationId"),
      startInstantISO: oldest,
      [PAGE_NONCE_KEY]: deps.nonce(),
    });
    crawl.pages += 1;
    mergeInto(overrides, page, "userOverrideNames");
    let added = 0;
    for (const message of records(page, "messages")) {
      const id = str(message, "wmgId");
      if (seen.has(id)) continue;
      seen.add(id);
      messages.push(message);
      added += 1;
    }
    more = bool(page, "hasMoreMessages");
    if (more && added === 0) {
      throw parseFailure("a message page claimed more but added nothing");
    }
  }
  return { messages, overrides };
}

// --- turning a crawl into threads ----------------------------------------------

function nameOf(value: unknown): string | undefined {
  const name = str(value, "name").trim();
  return name === "" ? undefined : name;
}

function authorOf(
  crawl: Crawl,
  overrides: ReadonlyMap<string, unknown>,
  author: unknown,
): { role: MessageAuthorRole; author?: string } {
  const empKey = str(author, "empKey");
  if (empKey !== "") {
    const override = overrides.get(empKey);
    const name =
      nameOf(crawl.users.get(empKey)) ??
      (typeof override === "string" && override.trim() !== "" ? override.trim() : undefined);
    return { role: "practitioner", ...(name !== undefined && { author: name }) };
  }
  const viewerKey = str(author, "wprKey");
  if (viewerKey !== "") {
    const viewer = crawl.viewers.get(viewerKey);
    // An unknown viewer key is still someone signed in to the chart: the patient
    // is the one it almost always is, but only a viewer that says so is.
    const role: MessageAuthorRole =
      viewer === undefined || bool(viewer, "isSelf") ? "patient" : "proxy";
    const name = nameOf(viewer);
    return { role, ...(name !== undefined && { author: name }) };
  }
  const display = str(author, "displayName").trim();
  return { role: "system", ...(display !== "" && { author: display }) };
}

function attachmentsOf(message: unknown): PortalMessageAttachment[] {
  return records(message, "attachments").map((attachment) => {
    const name = str(attachment, "name").trim();
    const extension = str(attachment, "fileExtension").trim();
    return { ...(name !== "" && { name }), ...(extension !== "" && { extension }) };
  });
}

function toMessage(
  crawl: Crawl,
  overrides: ReadonlyMap<string, unknown>,
  message: Json,
): PortalMessage | null {
  const sent = str(message, "deliveryInstantISO");
  if (Number.isNaN(Date.parse(sent))) return null;
  return {
    sent: new Date(sent).toISOString(),
    ...authorOf(crawl, overrides, own(message, "author")),
    body: messageText(str(message, "body")),
    attachments: attachmentsOf(message),
  };
}

function practitionersOf(conversation: unknown): { name: string }[] {
  const names = new Set<string>();
  for (const member of records(conversation, "audience")) {
    const name = nameOf(member);
    if (name !== undefined) names.add(name);
  }
  return [...names].map((name) => ({ name }));
}

function toThread(
  crawl: Crawl,
  conversation: Json,
  folder: MessageFolder,
  messages: readonly PortalMessage[],
): PortalThread {
  const orgId = str(conversation, "organizationId");
  const org = orgId === "" ? undefined : crawl.organizations.get(orgId);
  const external = orgId !== "" && org?.local !== true;
  const messageType = str(conversation, "messageType");
  const ordered = [...messages];
  ordered.sort((a, b) => (a.sent < b.sent ? -1 : Number(a.sent > b.sent)));
  return {
    subject: str(conversation, "subject").trim(),
    folder,
    external,
    ...(external && org !== undefined && org.name !== "" && { organization: org.name }),
    ...(messageType !== "" && { messageType }),
    practitioners: practitionersOf(conversation),
    messages: ordered,
  };
}

/**
 * Read the whole Message Center.
 *
 * Throws `portal_parse_failed` when paging stops making progress, and whatever
 * `post` throws (an expired session, a token failure) as it is.
 */
export async function loadMessageCenter(deps: LoadMessagesDeps): Promise<PortalMessagesResult> {
  const crawl: Crawl = {
    organizations: await readOrganizations(deps),
    users: new Map(),
    viewers: new Map(),
    conversations: new Map(),
    complete: true,
    pages: 0,
  };
  for (const { tag, folder } of MESSAGE_FOLDERS) await crawlFolder(deps, crawl, tag, folder);

  const threads: PortalThread[] = [];
  for (const { conversation, folder } of crawl.conversations.values()) {
    const { messages, overrides } = await crawlMessages(deps, crawl, conversation);
    const parsed = messages
      .map((message) => toMessage(crawl, overrides, message))
      .filter((message): message is PortalMessage => message !== null);
    // A conversation whose every message failed to parse is not a thread anyone
    // can read; it also cannot be keyed. Counted as incomplete rather than kept.
    if (parsed.length === 0) {
      crawl.complete = false;
      continue;
    }
    if (parsed.length < messages.length) crawl.complete = false;
    threads.push(toThread(crawl, conversation, folder, parsed));
  }
  return { threads, complete: crawl.complete, pages: crawl.pages };
}
