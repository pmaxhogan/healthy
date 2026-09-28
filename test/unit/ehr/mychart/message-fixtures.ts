// A synthetic MyChart Message Center: the JSON shapes a capture of the real API
// showed (`GetOrganizations`, `GetConversationList`, `GetConversationMessages`),
// served from an in-memory mailbox with the real paging rules -- fifty
// conversations a page per organisation, five older messages a page, and the
// local first page re-sent on every later page.
//
// Every name, subject, body and id below is invented. Nothing here came from a
// real record.

import { PATHS } from "../../../../worker/ehr/mychart/wire.ts";

export const LOCAL_ORG = "org-local-0000";
export const EXTERNAL_ORG = "org-external-0001";
export const SECOND_EXTERNAL_ORG = "org-external-0002";

/** Staff and viewer keys, as the list's `users` / `viewers` maps key them. */
export const NURSE_KEY = "emp-key-nurse";
export const DOCTOR_KEY = "emp-key-doctor";
export const SELF_KEY = "wpr-key-self";
export const PROXY_KEY = "wpr-key-proxy";

export interface FixtureMessage {
  id: string;
  sent: string;
  body: string;
  author: { empKey: string } | { wprKey: string } | { displayName: string };
  attachments?: { name: string; fileExtension: string }[];
  unread?: boolean;
}

export interface FixtureConversation {
  id: string;
  organizationId: string;
  tag: number;
  subject: string;
  messageType?: string;
  audience?: string[];
  /** Any order; the fake sorts them. */
  messages: FixtureMessage[];
  overrides?: Record<string, string>;
}

export interface MessageCenterState {
  organizations: { id: string; name: string; local: boolean }[];
  conversations: FixtureConversation[];
  /** Organisations the list leaves out of `externalSummaries` (a failing link). */
  silent: Set<string>;
  pageSize: number;
  /** A page that says there is more but returns nothing new, for the stuck guard. */
  stuck: boolean;
  requests: { path: string; body: Record<string, unknown> }[];
}

/** An ISO instant `minutes` after an invented epoch. */
function at(minutes: number): string {
  return new Date(Date.UTC(2026, 0, 1) + minutes * 60_000).toISOString().replace(".000Z", "Z");
}

/** A message with an invented body; `n` makes it unique. */
export function message(
  id: string,
  minutes: number,
  author: FixtureMessage["author"],
  body = `<div class="msg"><style nonce="n">.msg{color:red}</style><p>Invented note ${id}</p></div>`,
): FixtureMessage {
  return { id, sent: at(minutes), body, author };
}

function newestFirst<T extends { sent: string }>(items: readonly T[]): T[] {
  return items.toSorted((a, b) => b.sent.localeCompare(a.sent));
}

function newestOf(conversation: FixtureConversation): string {
  return newestFirst(conversation.messages)[0]?.sent ?? "";
}

function wireMessage(entry: FixtureMessage): Record<string, unknown> {
  return {
    wmgId: entry.id,
    isUnread: entry.unread === true,
    deliveryInstantISO: entry.sent,
    body: entry.body,
    author: { displayName: "", ...entry.author },
    attachments: (entry.attachments ?? []).map((attachment) => ({
      type: 2,
      dcsId: `dcs-${entry.id}`,
      etxId: "",
      ...attachment,
      organizationId: "",
    })),
    tasks: [],
    suggestedActions: [],
  };
}

function wireConversation(conversation: FixtureConversation): Record<string, unknown> {
  const ordered = newestFirst(conversation.messages);
  return {
    contexts: [],
    subject: conversation.subject,
    tags: { Messages: true },
    previewText: "",
    hasAttachments: false,
    audience: (conversation.audience ?? []).map((name, index) => ({
      empId: `emp-${String(index)}`,
      hipId: "",
      name,
      providerId: `prov-${String(index)}`,
    })),
    hthId: conversation.id,
    messages: ordered.slice(0, 5).map((entry) => wireMessage(entry)),
    hasMoreMessages: ordered.length > 5,
    messageType: conversation.messageType ?? "1",
    userKeys: [],
    userOverrideNames: conversation.overrides ?? {},
    maskedUserNames: [],
    viewerKeys: [SELF_KEY],
    organizationId: conversation.organizationId === LOCAL_ORG ? "" : conversation.organizationId,
  };
}

interface Params {
  loadStartInstantISO?: string;
}

/** One organisation's page: the conversations older than the cursor, newest first. */
function pageOf(
  state: MessageCenterState,
  orgId: string,
  tag: number,
  params: Params | null | undefined,
): { conversations: FixtureConversation[]; summary: Record<string, unknown> } {
  const all = newestFirst(
    state.conversations
      .filter((entry) => entry.organizationId === orgId && entry.tag === tag)
      .map((entry) => ({ entry, sent: newestOf(entry) })),
  );
  const cursor = params?.loadStartInstantISO ?? "";
  const older = cursor === "" ? all : all.filter((row) => row.sent < cursor);
  const page = cursor !== "" && state.stuck ? [] : older.slice(0, state.pageSize);
  const last = page.at(-1);
  return {
    conversations: page.map((row) => row.entry),
    summary: {
      hasMoreConversations: state.stuck || older.length > page.length,
      newestLoadedInstantISO: page[0]?.sent ?? "",
      numberLoaded: page.length,
      oldestLoadedInstantISO: last?.sent ?? cursor,
      oldestSearchedInstantISO: last?.sent ?? cursor,
      pagingInfo: 0,
    },
  };
}

const USERS = {
  [NURSE_KEY]: { empId: "e1", name: "Nurse Example A", providerId: "p1", organizationId: "" },
  [DOCTOR_KEY]: { empId: "e2", name: "Dr Example B", providerId: "p2", organizationId: "" },
};

const VIEWERS = {
  [SELF_KEY]: { wprId: "w1", name: "Test Person", isSelf: true, organizationId: "" },
  [PROXY_KEY]: { wprId: "w2", name: "Test Proxy", isSelf: false, organizationId: "" },
};

function listPage(state: MessageCenterState, body: Record<string, unknown>): unknown {
  const tag = Number(body.tag);
  const local = pageOf(state, LOCAL_ORG, tag, body.localLoadParams as Params | null | undefined);
  const conversations = [...local.conversations];
  const externalSummaries: Record<string, unknown> = {};
  const external = (body.externalLoadParams ?? {}) as Record<
    string,
    { communicationCenter?: Params }
  >;
  for (const [orgId, boxes] of Object.entries(external)) {
    if (state.silent.has(orgId)) continue;
    const page = pageOf(state, orgId, tag, boxes.communicationCenter);
    conversations.push(...page.conversations);
    externalSummaries[orgId] = { communicationCenter: page.summary, organizationId: orgId };
  }
  return {
    legacyXUnreadCount: 0,
    conversations: conversations.map((entry) => wireConversation(entry)),
    localSummary: local.summary,
    users: USERS,
    viewers: VIEWERS,
    externalSummaries,
  };
}

function olderMessages(state: MessageCenterState, body: Record<string, unknown>): unknown {
  const conversation = state.conversations.find((entry) => entry.id === body.id);
  const start = typeof body.startInstantISO === "string" ? body.startInstantISO : "";
  const older = newestFirst(conversation?.messages ?? []).filter((entry) => entry.sent < start);
  const page = state.stuck ? [] : older.slice(0, 5);
  return {
    contexts: [],
    hthId: body.id,
    messages: page.map((entry) => wireMessage(entry)),
    hasMoreMessages: state.stuck || older.length > page.length,
    messageType: "1",
    userKeys: [],
    userOverrideNames: conversation?.overrides ?? {},
    maskedUserNames: [],
    viewerKeys: [SELF_KEY],
    organizationId: body.organizationId,
  };
}

export function messageCenter(overrides: Partial<MessageCenterState> = {}): MessageCenterState {
  return {
    organizations: [
      { id: LOCAL_ORG, name: "Example Health", local: true },
      { id: EXTERNAL_ORG, name: "Other Example Clinic", local: false },
    ],
    conversations: [],
    silent: new Set(),
    pageSize: 50,
    stuck: false,
    requests: [],
    ...overrides,
  };
}

/** Answer one Message Center POST the way the real API does. */
export function answerMessageCenter(
  state: MessageCenterState,
  path: string,
  body: Record<string, unknown>,
): unknown {
  state.requests.push({ path, body });
  if (path === PATHS.conversationOrganizations) {
    return {
      organizations: Object.fromEntries(
        state.organizations.map((org) => [
          org.id,
          { organizationId: org.id, organizationName: org.name, isLocal: org.local },
        ]),
      ),
    };
  }
  if (path === PATHS.conversationList) return listPage(state, body);
  if (path === PATHS.conversationMessages) return olderMessages(state, body);
  throw new Error(`unexpected message center path ${path}`);
}
