// `get_messages` and `get_message_thread`: the portals' secure messages.
//
// What is pinned here:
//
//   - the envelope every tool answers with; get_messages lists one item per
//     conversation, newest activity first, with counts, dates, participants and
//     a labelled preview of the newest message; get_message_thread answers one
//     conversation with every message in full, oldest first
//   - one message two portals show is one message, from the health system whose
//     own conversation it is; a message only one portal shows is kept,
//     second-hand copies included; near-duplicates are not merged
//   - a denied health system's messages are gone, and so is any copy of them
//     another portal shows
//   - the owner's rules on people's names reach each sender by who they are --
//     one message at a time, so hiding the patient's name leaves a clinician's
//     name in the same conversation -- and the care team; a rule on a
//     conversation's own fields reaches those; a `Communication` resource rule
//     removes every conversation and its coverage
//   - `search` sees only what the policy released
//   - coverage comes from the portal pass's own record of its last read
//   - the window (on the newest message), folder and search filters
//
// Every message below is synthetic.

import { beforeEach, describe, expect, it } from "vitest";

import { PREVIEW_CHARS, previewOf } from "../../../src/mcp/message-threads.ts";
import { previewDraft, sampleStructure } from "../../../src/mcp/policy-sample.ts";
import { buildRules } from "../../../src/policy/rules.ts";
import { STALE_SECONDS } from "../../../src/sync/portal-dedupe.ts";

import {
  HEALTH_SYSTEM_A,
  HEALTH_SYSTEM_B,
  NAME_A,
  NOW,
  callTool,
  connectTools,
  fakeDeps,
  fakeState,
} from "./helpers.ts";

import type { FakeState } from "./helpers.ts";
import type { MessageAuthorRole } from "../../../src/ehr/mychart/index.ts";
import type { PortalMessageRecord, PortalMessageSyncEntry } from "../../../src/mcp/deps.ts";
import type { PolicyRuleInput } from "../../../src/policy/rules.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const rules = (...input: PolicyRuleInput[]) => buildRules(input);

interface RecordOptions {
  thread?: string;
  subject?: string;
  sent: string;
  role?: MessageAuthorRole;
  author?: string;
  body?: string;
  external?: boolean;
  folder?: PortalMessageRecord["thread"]["folder"];
  missing?: boolean;
  unread?: boolean;
  attachments?: { name?: string; extension?: string }[];
  files?: PortalMessageRecord["files"];
  /** Defaults to one derived from `sent` and `body`: what the repo would compute. */
  fingerprint?: string;
}

function record(options: RecordOptions): PortalMessageRecord {
  const body = options.body ?? `Invented text sent ${options.sent}`;
  const thread = options.thread ?? "thread-1";
  const fingerprint =
    options.fingerprint ?? `fp:${options.sent}:${options.role ?? "practitioner"}:${body}`;
  return {
    threadId: thread,
    messageId: `msg:${thread}:${fingerprint}`,
    fingerprint,
    thread: {
      subject: options.subject ?? "Invented subject",
      folder: options.folder ?? "conversations",
      external: options.external === true,
      ...(options.external === true && { organization: "Elsewhere Example Group" }),
      practitioners: [{ name: "Nurse Example A" }],
    },
    message: {
      sent: options.sent,
      role: options.role ?? "practitioner",
      ...(options.author !== undefined && { author: options.author }),
      body,
      attachments: options.attachments ?? [],
      ...(options.unread !== undefined && { unread: options.unread }),
    },
    ...(options.files !== undefined && { files: options.files }),
    missing: options.missing === true,
  };
}

function synced(healthSystemId: string, overrides: Partial<PortalMessageSyncEntry> = {}) {
  return {
    healthSystemId,
    lastAttemptAt: NOW - 600,
    lastOkAt: NOW - 600,
    lastErrorCode: null,
    complete: true,
    ...overrides,
  };
}

/** The world each test starts from. A holder, so `beforeEach` assigns a property. */
const world: { state: FakeState; client: Client } = {
  state: fakeState(),
  client: undefined as unknown as Client,
};

beforeEach(async () => {
  world.state = fakeState({
    messageSync: [synced(HEALTH_SYSTEM_A), synced(HEALTH_SYSTEM_B)],
  });
  world.client = await connectTools(fakeDeps(world.state));
});

function store(healthSystemId: string, records: PortalMessageRecord[]): void {
  world.state.portalMessages.set(healthSystemId, records);
}

/** The one thread get_message_thread answers, and its messages. */
async function thread(threadId = "thread-1") {
  const answer = await callTool(world.client, "get_message_thread", { threadId });
  const item = answer.items[0] ?? {};
  return { answer, item, messages: (item.messages ?? []) as Record<string, unknown>[] };
}

/** Every message body across every conversation get_message_thread answers for these ids. */
async function bodies(...threadIds: string[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const id of threadIds) {
    const { messages } = await thread(id);
    out.push(...messages.map((message) => message.body));
  }
  return out;
}

describe("get_messages", () => {
  it("answers one item per conversation, newest activity first, in the shared envelope", async () => {
    store(HEALTH_SYSTEM_A, [
      record({ sent: "2026-03-01T10:00:00.000Z", role: "patient", author: "Test Person" }),
      record({
        sent: "2026-03-02T10:00:00.000Z",
        author: "Nurse Example A",
        unread: true,
        attachments: [{ name: "invented.pdf", extension: "PDF" }],
      }),
      record({ thread: "thread-2", sent: "2026-02-01T10:00:00.000Z", role: "system" }),
    ]);

    const answer = await callTool(world.client, "get_messages");

    expect(answer.isError).toBe(false);
    expect(answer.total).toBe(2);
    expect(JSON.parse(answer.text)).toMatchObject({ messages: 3 });
    expect(answer.items.map((item) => item.threadId)).toStrictEqual(["thread-1", "thread-2"]);
    expect(answer.items[0]).toStrictEqual({
      resourceType: "Communication",
      kind: "message_thread",
      threadId: "thread-1",
      subject: "Invented subject",
      folder: "conversations",
      firstMessageAt: "2026-03-01T10:00:00.000Z",
      lastMessageAt: "2026-03-02T10:00:00.000Z",
      messageCount: 2,
      unreadCount: 1,
      attachmentCount: 1,
      hasAttachments: true,
      practitioners: [{ name: "Nurse Example A" }],
      participants: [
        { role: "patient", name: "Test Person" },
        { role: "practitioner", name: "Nurse Example A" },
      ],
      lastMessage: {
        id: "msg:thread-1:fp:2026-03-02T10:00:00.000Z:practitioner:Invented text sent 2026-03-02T10:00:00.000Z",
        sent: "2026-03-02T10:00:00.000Z",
        direction: "to_patient",
        from: { role: "practitioner", name: "Nurse Example A" },
        preview: "Invented text sent 2026-03-02T10:00:00.000Z",
        previewTruncated: false,
      },
      source: "portal",
      firstParty: true,
      healthSystem: NAME_A,
      healthSystemId: HEALTH_SYSTEM_A,
    });
    // No body in the list: the preview is all there is of it.
    expect(answer.items[0]).not.toHaveProperty("messages");
    expect(answer.coverage).toStrictEqual([
      expect.objectContaining({ healthSystemId: HEALTH_SYSTEM_A, status: "ok" }),
      expect.objectContaining({ healthSystemId: HEALTH_SYSTEM_B, status: "ok" }),
    ]);
  });

  it("previews the newest message's first characters, and says when it cut them", async () => {
    const long = `${"word ".repeat(60)}end`;
    store(HEALTH_SYSTEM_A, [record({ sent: "2026-03-01T10:00:00.000Z", body: long })]);

    const answer = await callTool(world.client, "get_messages");
    const last = answer.items[0]?.lastMessage as Record<string, unknown>;

    expect(last.previewTruncated).toBe(true);
    expect(String(last.preview).endsWith("…")).toBe(true);
    expect(String(last.preview).length).toBeLessThanOrEqual(PREVIEW_CHARS + 1);
    expect(long.startsWith(String(last.preview).slice(0, -1))).toBe(true);
  });

  it("omits unreadCount for rows stored before the unread flag was kept", async () => {
    store(HEALTH_SYSTEM_A, [record({ sent: "2026-03-01T10:00:00.000Z" })]);

    const answer = await callTool(world.client, "get_messages");

    expect(answer.items[0]).not.toHaveProperty("unreadCount");
    expect(answer.items[0]).toMatchObject({ hasAttachments: false, attachmentCount: 0 });
  });

  it("answers a message both portals show once, from the health system it belongs to", async () => {
    const shared = { sent: "2026-03-01T10:00:00.000Z", body: "The same invented text." };
    store(HEALTH_SYSTEM_A, [record({ ...shared, external: true })]);
    store(HEALTH_SYSTEM_B, [record(shared)]);

    const answer = await callTool(world.client, "get_messages");

    expect(answer.items).toHaveLength(1);
    expect(answer.items[0]).toMatchObject({
      healthSystemId: HEALTH_SYSTEM_B,
      firstParty: true,
      messageCount: 1,
    });
    expect(answer.items[0]).not.toHaveProperty("via");
  });

  it("keeps a message only one portal shows, and a second-hand copy with no first-party one", async () => {
    store(HEALTH_SYSTEM_A, [
      record({ sent: "2026-03-01T10:00:00.000Z", role: "system", body: "An invented notice." }),
      record({
        thread: "thread-2",
        sent: "2026-03-03T10:00:00.000Z",
        external: true,
        body: "From elsewhere.",
      }),
    ]);
    store(HEALTH_SYSTEM_B, []);

    const answer = await callTool(world.client, "get_messages");

    expect(answer.items).toHaveLength(2);
    expect(answer.items[0]).toMatchObject({
      threadId: "thread-2",
      firstParty: false,
      via: HEALTH_SYSTEM_A,
      organization: "Elsewhere Example Group",
    });
  });

  it("answers a conversation split across two portals as one item per health system", async () => {
    // B has not listed the newest reply yet; A's second-hand copy is all there is of it.
    store(HEALTH_SYSTEM_A, [
      record({ sent: "2026-03-01T10:00:00.000Z", external: true, body: "First." }),
      record({ sent: "2026-03-02T10:00:00.000Z", external: true, body: "Reply." }),
    ]);
    store(HEALTH_SYSTEM_B, [record({ sent: "2026-03-01T10:00:00.000Z", body: "First." })]);

    const answer = await callTool(world.client, "get_messages");
    const detail = await thread();

    expect(answer.items.map((item) => [item.healthSystemId, item.messageCount])).toStrictEqual([
      [HEALTH_SYSTEM_A, 1],
      [HEALTH_SYSTEM_B, 1],
    ]);
    expect(detail.answer.items).toHaveLength(2);
  });

  it("does not merge near-duplicates: same second with other text, same text a second apart", async () => {
    store(HEALTH_SYSTEM_A, [
      record({ sent: "2026-03-01T10:00:00.000Z", body: "Invented text." }),
      record({ sent: "2026-03-01T10:00:01.000Z", body: "Invented text.", external: true }),
    ]);
    store(HEALTH_SYSTEM_B, [
      record({ sent: "2026-03-01T10:00:00.000Z", body: "Other invented text." }),
      record({ sent: "2026-03-01T10:00:01.000Z", body: "Invented text!" }),
    ]);

    const answer = await callTool(world.client, "get_messages");

    expect(JSON.parse(answer.text)).toMatchObject({ messages: 4 });
  });

  it("drops a denied health system's messages and every copy another portal shows", async () => {
    const shared = { sent: "2026-03-01T10:00:00.000Z", body: "Belongs to B." };
    store(HEALTH_SYSTEM_A, [
      record({ ...shared, external: true }),
      record({ sent: "2026-03-05T10:00:00.000Z", body: "A's own." }),
    ]);
    store(HEALTH_SYSTEM_B, [record(shared)]);
    world.state.rules = rules({ rule_type: "health_system", target: HEALTH_SYSTEM_B });

    const answer = await callTool(world.client, "get_messages");

    expect(answer.items).toHaveLength(1);
    expect(await bodies("thread-1")).toStrictEqual(["A's own."]);
    expect(answer.coverage?.map((entry) => entry.healthSystemId)).toStrictEqual([HEALTH_SYSTEM_A]);
  });

  it("answers from only the health systems asked for, the copy belonging where it belongs", async () => {
    const shared = { sent: "2026-03-01T10:00:00.000Z", body: "Belongs to B." };
    store(HEALTH_SYSTEM_A, [record({ ...shared, external: true })]);
    store(HEALTH_SYSTEM_B, [record(shared)]);

    const onlyA = await callTool(world.client, "get_messages", { healthSystems: [NAME_A] });

    expect(onlyA.items).toStrictEqual([]);
  });

  it("windows on the newest message, keeping a conversation whole, and filters by folder", async () => {
    store(HEALTH_SYSTEM_A, [
      record({ sent: "2026-01-15T10:00:00.000Z", role: "patient" }),
      record({ sent: "2026-02-15T10:00:00.000Z" }),
      record({ thread: "thread-auto", sent: "2026-03-15T10:00:00.000Z", folder: "automated" }),
    ]);

    const february = await callTool(world.client, "get_messages", {
      from: "2026-02-01",
      to: "2026-02-28",
    });
    const january = await callTool(world.client, "get_messages", { to: "2026-01-31" });
    // A month-only bound is that whole UTC month, both ends inclusive.
    const month = await callTool(world.client, "get_messages", { from: "2026-02", to: "2026-02" });
    const automated = await callTool(world.client, "get_messages", { folder: "automated" });

    expect(february.items.map((item) => [item.threadId, item.messageCount])).toStrictEqual([
      ["thread-1", 2],
    ]);
    expect(january.items).toStrictEqual([]);
    expect(month.items.map((item) => item.threadId)).toStrictEqual(["thread-1"]);
    expect(automated.items.map((item) => item.threadId)).toStrictEqual(["thread-auto"]);
  });

  it("searches the subject and every message's full text, ignoring case and spacing", async () => {
    store(HEALTH_SYSTEM_A, [
      record({ sent: "2026-03-01T10:00:00.000Z", body: "An early note about a Refill\nrequest." }),
      record({ sent: "2026-03-02T10:00:00.000Z", body: "Something else entirely." }),
      record({ thread: "thread-2", subject: "Refill request", sent: "2026-02-01T10:00:00.000Z" }),
      record({ thread: "thread-3", sent: "2026-02-02T10:00:00.000Z" }),
    ]);

    const answer = await callTool(world.client, "get_messages", { search: "refill  REQUEST" });

    expect(answer.items.map((item) => item.threadId)).toStrictEqual(["thread-1", "thread-2"]);
  });

  it("does not let search see a body the policy withheld", async () => {
    store(HEALTH_SYSTEM_A, [
      record({ sent: "2026-03-01T10:00:00.000Z", body: "Invented secret." }),
    ]);
    world.state.rules = rules({
      rule_type: "field",
      target: "sig-body",
      scope_resource: "Communication",
      paths_json: JSON.stringify(["body"]),
    });

    const answer = await callTool(world.client, "get_messages", { search: "secret" });

    expect(answer.items).toStrictEqual([]);
  });

  it("marks a conversation its own portal stopped listing entirely", async () => {
    store(HEALTH_SYSTEM_A, [record({ sent: "2026-03-01T10:00:00.000Z", missing: true })]);

    const answer = await callTool(world.client, "get_messages");

    expect(answer.items[0]).toMatchObject({ noLongerListed: true });
  });
});

describe("the message tools under the owner's name rules", () => {
  // The shape of a real deployment's rules: clinicians' records denied, the
  // care-team field and every top-level name hidden.
  const OWNER_RULES = rules(
    { rule_type: "resource", target: "Practitioner" },
    {
      rule_type: "field",
      target: "sig-1",
      scope_resource: "Practitioner",
      paths_json: JSON.stringify(["name"]),
    },
    { rule_type: "field", target: "sig-2", paths_json: JSON.stringify(["practitioners"]) },
    {
      rule_type: "field",
      target: "sig-3",
      paths_json: JSON.stringify(["address", "contact", "name", "text"]),
    },
  );

  beforeEach(() => {
    store(HEALTH_SYSTEM_A, [
      record({ sent: "2026-03-01T10:00:00.000Z", role: "patient", author: "Test Person" }),
      record({ sent: "2026-03-02T10:00:00.000Z", author: "Nurse Example A" }),
      record({ sent: "2026-03-03T10:00:00.000Z", role: "system", author: "Messaging System" }),
    ]);
  });

  it("removes clinicians' and the patient's names but keeps every message", async () => {
    world.state.rules = OWNER_RULES;

    const list = await callTool(world.client, "get_messages");
    const detail = await thread();

    for (const text of [list.text, detail.answer.text]) {
      expect(text).not.toContain("Test Person");
      expect(text).not.toContain("Nurse Example A");
    }
    expect(list.items[0]?.participants).toStrictEqual([
      { role: "patient" },
      { role: "practitioner" },
      // Nobody's name: a system sender is the organisation's own mailbox.
      { role: "system", name: "Messaging System" },
    ]);
    expect(list.items[0]).not.toHaveProperty("practitioners");
    const [patient, practitioner, system] = detail.messages;
    expect(patient?.from).toStrictEqual({ role: "patient" });
    expect(practitioner?.from).toStrictEqual({ role: "practitioner" });
    expect(system?.from).toStrictEqual({ role: "system", name: "Messaging System" });
    expect(practitioner?.body).toBe("Invented text sent 2026-03-02T10:00:00.000Z");
    expect(detail.item.subject).toBe("Invented subject");
  });

  it("withholds the patient's name alone, leaving the clinician's in the same conversation", async () => {
    world.state.rules = rules({
      rule_type: "field",
      target: "sig-5",
      scope_resource: "Patient",
      paths_json: JSON.stringify(["name"]),
    });

    const detail = await thread();

    expect(detail.answer.text).not.toContain("Test Person");
    expect(detail.messages.map((message) => message.from)).toStrictEqual([
      { role: "patient" },
      { role: "practitioner", name: "Nurse Example A" },
      { role: "system", name: "Messaging System" },
    ]);
    expect(detail.answer.warnings).toContain("policy_reference_display_removed:Patient");
  });

  it("removes clinicians' names wherever a rule withholds them from another record", async () => {
    world.state.rules = rules({
      rule_type: "field",
      target: "sig-4",
      scope_resource: "Encounter",
      paths_json: JSON.stringify(["practitioners"]),
    });

    const answer = await callTool(world.client, "get_messages");

    expect(answer.text).not.toContain("Nurse Example A");
    expect(answer.warnings).toContain("policy_reference_display_removed:Practitioner");
  });

  it("reaches a conversation's own fields: a preview in the list, bodies in the thread", async () => {
    world.state.rules = rules(
      {
        rule_type: "field",
        target: "sig-6",
        scope_tool: "get_messages",
        paths_json: JSON.stringify(["lastMessage.preview"]),
      },
      {
        rule_type: "field",
        target: "sig-7",
        scope_tool: "get_message_thread",
        paths_json: JSON.stringify(["messages[].body"]),
      },
    );

    const list = await callTool(world.client, "get_messages");
    const detail = await thread();

    expect(list.items[0]?.lastMessage).not.toHaveProperty("preview");
    expect(detail.messages).toHaveLength(3);
    for (const message of detail.messages) expect(message).not.toHaveProperty("body");
  });

  it("removes every conversation, and the coverage, on a Communication resource rule", async () => {
    world.state.rules = rules({ rule_type: "resource", target: "Communication" });

    const answer = await callTool(world.client, "get_messages");
    const detail = await thread();

    expect(answer.items).toStrictEqual([]);
    expect(answer.coverage).toStrictEqual([]);
    expect(detail.answer.items).toStrictEqual([]);
  });

  it("answers policy_denied when the tool itself is denied", async () => {
    world.state.rules = rules({ rule_type: "tool", target: "get_messages" });

    const answer = await callTool(world.client, "get_messages");

    expect(answer.isError).toBe(true);
    expect(answer.error).toBe("policy_denied");
  });
});

describe("get_messages coverage", () => {
  it("reports never, failed, partial and stale from the portal pass's own record", async () => {
    world.state.messageSync = [
      synced(HEALTH_SYSTEM_A, { lastErrorCode: "portal_session_expired" }),
      synced(HEALTH_SYSTEM_B, { lastOkAt: NOW - 7 * 3600 }),
    ];

    const answer = await callTool(world.client, "get_messages");

    expect(answer.coverage).toStrictEqual([
      expect.objectContaining({
        healthSystemId: HEALTH_SYSTEM_A,
        resourceType: "Communication",
        status: "failed",
        errorCode: "portal_session_expired",
      }),
      expect.objectContaining({ healthSystemId: HEALTH_SYSTEM_B, status: "stale", ageHours: 7 }),
    ]);
    expect(answer.warnings).toContain("incomplete_no_data_is_not_absence");
    expect(answer.warnings).toContain(
      `sync_failed:Communication:${HEALTH_SYSTEM_A}:portal_session_expired`,
    );

    world.state.messageSync = [synced(HEALTH_SYSTEM_A, { complete: false })];
    const partial = await callTool(world.client, "get_messages");
    expect(partial.coverage).toStrictEqual([
      expect.objectContaining({ healthSystemId: HEALTH_SYSTEM_A, status: "partial" }),
      expect.objectContaining({ healthSystemId: HEALTH_SYSTEM_B, status: "never" }),
    ]);
  });

  it("lets a fresh second-hand copy speak once its own portal has gone quiet", async () => {
    const shared = { sent: "2026-03-01T10:00:00.000Z", body: "Belongs to B." };
    store(HEALTH_SYSTEM_A, [record({ ...shared, external: true })]);
    store(HEALTH_SYSTEM_B, [record(shared)]);
    world.state.messageSync = [
      synced(HEALTH_SYSTEM_A),
      synced(HEALTH_SYSTEM_B, { lastOkAt: NOW - STALE_SECONDS - 60 }),
    ];

    const answer = await callTool(world.client, "get_messages");

    expect(answer.items).toHaveLength(1);
    expect(answer.items[0]).toMatchObject({ healthSystemId: HEALTH_SYSTEM_A, firstParty: false });
  });
});

describe("get_message_thread", () => {
  it("answers one conversation with every message in full, oldest first", async () => {
    store(HEALTH_SYSTEM_A, [
      record({ sent: "2026-03-02T10:00:00.000Z", author: "Nurse Example A", unread: false }),
      record({
        sent: "2026-03-01T10:00:00.000Z",
        role: "patient",
        attachments: [{ name: "invented.png", extension: "PNG" }],
      }),
      record({ thread: "thread-2", sent: "2026-03-05T10:00:00.000Z" }),
    ]);

    const { answer, item, messages } = await thread();

    expect(answer.total).toBe(1);
    expect(item).toMatchObject({
      kind: "message_thread_detail",
      threadId: "thread-1",
      messageCount: 2,
      firstMessageAt: "2026-03-01T10:00:00.000Z",
      lastMessageAt: "2026-03-02T10:00:00.000Z",
    });
    expect(item).not.toHaveProperty("lastMessage");
    expect(messages).toStrictEqual([
      {
        id: "msg:thread-1:fp:2026-03-01T10:00:00.000Z:patient:Invented text sent 2026-03-01T10:00:00.000Z",
        sent: "2026-03-01T10:00:00.000Z",
        direction: "from_patient",
        from: { role: "patient" },
        body: "Invented text sent 2026-03-01T10:00:00.000Z",
        attachments: [{ name: "invented.png", extension: "PNG" }],
      },
      {
        id: "msg:thread-1:fp:2026-03-02T10:00:00.000Z:practitioner:Invented text sent 2026-03-02T10:00:00.000Z",
        sent: "2026-03-02T10:00:00.000Z",
        direction: "to_patient",
        from: { role: "practitioner", name: "Nurse Example A" },
        unread: false,
        body: "Invented text sent 2026-03-02T10:00:00.000Z",
        attachments: [],
      },
    ]);
  });

  it("says when there is no such thread", async () => {
    const { answer } = await thread("no-such");

    expect(answer.items).toStrictEqual([]);
    expect(answer.warnings).toContain("thread_not_found");
  });

  it("requires a thread id", async () => {
    const answer = await callTool(world.client, "get_message_thread");

    expect(answer.isError).toBe(true);
  });
});

/** The bodies of a get_message_thread item's messages. */
const bodiesOf = (item: unknown) =>
  ((item as { messages?: { body?: string }[] }).messages ?? []).map((entry) => entry.body);

describe("the rule builder's samples of the message tools", () => {
  beforeEach(() => {
    store(HEALTH_SYSTEM_A, [
      record({ sent: "2026-03-01T10:00:00.000Z", role: "patient" }),
      record({ thread: "thread-2", sent: "2026-03-05T10:00:00.000Z" }),
    ]);
  });

  it("reads get_message_thread's structure from the newest conversation get_messages lists", async () => {
    const structure = await sampleStructure(fakeDeps(world.state), "get_message_thread");

    expect(structure?.items).toBe(1);
    const names = structure?.item.map((node) => node.name) ?? [];
    expect(names).toContain("messages");
    expect(names).not.toContain("lastMessage");
  });

  it("previews a draft on a conversation's own field, in the thread tool", async () => {
    const preview = await previewDraft(fakeDeps(world.state), [], {
      tool: "get_message_thread",
      field: {
        effect: "hide",
        tool: "get_message_thread",
        resourceType: "Communication",
        healthSystemId: null,
        paths: ["messages[].body"],
      },
    });

    const [only] = preview.tools;
    expect(only).toMatchObject({ tool: "get_message_thread", total: 1, affected: 1 });
    expect(bodiesOf(only?.sample?.before)).toStrictEqual([
      "Invented text sent 2026-03-05T10:00:00.000Z",
    ]);
    expect(bodiesOf(only?.sample?.after)).toStrictEqual([undefined]);
  });
});

/** One message on HEALTH_SYSTEM_A with these attachment files. */
function withFiles(files: NonNullable<PortalMessageRecord["files"]>): void {
  store(HEALTH_SYSTEM_A, [
    record({
      sent: "2026-03-01T10:00:00.000Z",
      attachments: files.map((_, index) => ({
        name: `invented-${String(index)}`,
        extension: "X",
      })),
      files,
    }),
  ]);
}

describe("get_message_attachment", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9]);

  it("reports each attachment's id and status on the thread's messages", async () => {
    withFiles([
      { id: "att-1", status: "stored", contentType: "image/png", size: 6 },
      { id: "att-2", status: "waiting_until_read" },
    ]);

    const { messages } = await thread();

    expect(messages[0]?.attachments).toStrictEqual([
      {
        name: "invented-0",
        extension: "X",
        id: "att-1",
        status: "stored",
        contentType: "image/png",
        size: 6,
      },
      { name: "invented-1", extension: "X", id: "att-2", status: "waiting_until_read" },
    ]);
  });

  it("returns a stored image as an image content block beside the item", async () => {
    withFiles([{ id: "att-1", status: "stored", contentType: "image/png", size: 6 }]);
    world.state.attachmentContent.set(`${HEALTH_SYSTEM_A}:att-1`, PNG);

    const result = (await world.client.callTool({
      name: "get_message_attachment",
      arguments: { attachmentId: "att-1" },
    })) as { content: { type: string; data?: string; mimeType?: string; text?: string }[] };

    const [text, image] = result.content;
    const payload = JSON.parse(text?.text ?? "{}") as { items: Record<string, unknown>[] };
    expect(payload.items[0]).toMatchObject({
      kind: "message_attachment",
      id: "att-1",
      status: "stored",
      name: "invented-0",
      image: { contentType: "image/png" },
      threadId: "thread-1",
      healthSystemId: HEALTH_SYSTEM_A,
    });
    expect(image).toStrictEqual({ type: "image", data: "iVBORwkJ", mimeType: "image/png" });
  });

  it("withholds the image when a rule hides it", async () => {
    withFiles([{ id: "att-1", status: "stored", contentType: "image/png", size: 6 }]);
    world.state.attachmentContent.set(`${HEALTH_SYSTEM_A}:att-1`, PNG);
    world.state.rules = rules({
      rule_type: "field",
      target: "sig-img",
      scope_tool: "get_message_attachment",
      paths_json: JSON.stringify(["image"]),
    });

    const result = (await world.client.callTool({
      name: "get_message_attachment",
      arguments: { attachmentId: "att-1" },
    })) as { content: { type: string }[] };

    expect(result.content.map((block) => block.type)).toStrictEqual(["text"]);
  });

  it("returns a stored text file's text", async () => {
    withFiles([
      { id: "att-1", status: "stored", contentType: "text/html; charset=utf-8", size: 20 },
    ]);
    world.state.attachmentContent.set(
      `${HEALTH_SYSTEM_A}:att-1`,
      new TextEncoder().encode("<p>Invented &amp; text</p>"),
    );

    const answer = await callTool(world.client, "get_message_attachment", {
      attachmentId: "att-1",
    });

    expect(answer.items[0]).toMatchObject({ text: "Invented & text", chars: 15 });
  });

  it("says why there is no content: a PDF, a failure, an unread message", async () => {
    withFiles([
      { id: "att-pdf", status: "stored", contentType: "application/pdf", size: 1000 },
      { id: "att-bad", status: "failed", errorCode: "portal_parse_failed" },
      { id: "att-wait", status: "waiting_until_read" },
    ]);
    world.state.attachmentContent.set(`${HEALTH_SYSTEM_A}:att-pdf`, new Uint8Array(1000));

    const pdf = await callTool(world.client, "get_message_attachment", { attachmentId: "att-pdf" });
    const bad = await callTool(world.client, "get_message_attachment", { attachmentId: "att-bad" });
    const wait = await callTool(world.client, "get_message_attachment", {
      attachmentId: "att-wait",
    });

    expect(pdf.items[0]).toMatchObject({ contentType: "application/pdf", size: 1000 });
    expect(pdf.items[0]).not.toHaveProperty("text");
    expect(pdf.items[0]?.note).toContain("cannot be returned");
    expect(bad.items[0]).toMatchObject({ status: "failed", errorCode: "portal_parse_failed" });
    expect(wait.items[0]?.note).toContain("unread");
  });

  it("finds nothing under an id no visible message has, or under a Communication rule", async () => {
    withFiles([{ id: "att-1", status: "stored", contentType: "image/png", size: 6 }]);
    world.state.attachmentContent.set(`${HEALTH_SYSTEM_A}:att-1`, PNG);

    const none = await callTool(world.client, "get_message_attachment", { attachmentId: "nope" });
    world.state.rules = rules({ rule_type: "resource", target: "Communication" });
    const denied = (await world.client.callTool({
      name: "get_message_attachment",
      arguments: { attachmentId: "att-1" },
    })) as { content: { type: string; text?: string }[] };

    expect(none.items).toStrictEqual([]);
    expect(none.warnings).toContain("attachment_not_found");
    expect(denied.content.map((block) => block.type)).toStrictEqual(["text"]);
    expect(JSON.parse(denied.content[0]?.text ?? "{}")).toMatchObject({ items: [] });
  });
});

describe("previewOf", () => {
  it("collapses whitespace, keeps a short text whole, and never cuts a character in two", () => {
    expect(previewOf("  a\n\n b  ")).toStrictEqual({ preview: "a b", previewTruncated: false });
    const emoji = "😀".repeat(PREVIEW_CHARS + 5);
    const cut = previewOf(emoji);
    expect(cut.previewTruncated).toBe(true);
    expect(cut.preview).toBe(`${"😀".repeat(PREVIEW_CHARS)}…`);
  });
});
