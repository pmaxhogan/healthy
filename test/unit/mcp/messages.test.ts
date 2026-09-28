// `get_messages` and `get_message_thread`: the portals' secure messages.
//
// What is pinned here:
//
//   - the envelope every tool answers with, every message, newest first
//   - one message two portals show is one item, from the health system whose own
//     conversation it is; a message only one portal shows is kept, second-hand
//     copies included; near-duplicates are not merged
//   - a denied health system's messages are gone, and so is any copy of them
//     another portal shows
//   - the owner's rules on people's names reach the sender and the care team, by
//     who they are; a `Communication` resource rule removes messages and their
//     coverage
//   - coverage comes from the portal pass's own record of its last read
//   - the window, folder, direction and thread filters
//
// Every message below is synthetic.

import { beforeEach, describe, expect, it } from "vitest";

import { buildRules } from "../../../worker/policy/rules.ts";
import { STALE_SECONDS } from "../../../worker/sync/portal-dedupe.ts";

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
import type { MessageAuthorRole } from "../../../worker/ehr/mychart/index.ts";
import type { PortalMessageRecord, PortalMessageSyncEntry } from "../../../worker/mcp/deps.ts";
import type { PolicyRuleInput } from "../../../worker/policy/rules.ts";
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
      attachments: [],
    },
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

describe("get_messages", () => {
  it("answers every message, newest first, in the shared envelope", async () => {
    store(HEALTH_SYSTEM_A, [
      record({ sent: "2026-03-01T10:00:00.000Z", role: "patient", author: "Test Person" }),
      record({ sent: "2026-03-02T10:00:00.000Z", author: "Nurse Example A" }),
      record({ thread: "thread-2", sent: "2026-02-01T10:00:00.000Z", role: "system" }),
    ]);

    const answer = await callTool(world.client, "get_messages");

    expect(answer.isError).toBe(false);
    expect(answer.total).toBe(3);
    expect(answer.truncated).toBe(false);
    expect(answer.items.map((item) => item.sent)).toStrictEqual([
      "2026-03-02T10:00:00.000Z",
      "2026-03-01T10:00:00.000Z",
      "2026-02-01T10:00:00.000Z",
    ]);
    expect(answer.items[1]).toMatchObject({
      resourceType: "Communication",
      threadId: "thread-1",
      subject: "Invented subject",
      direction: "from_patient",
      from: { role: "patient", name: "Test Person" },
      source: "portal",
      firstParty: true,
      healthSystem: NAME_A,
      healthSystemId: HEALTH_SYSTEM_A,
    });
    expect(answer.items[0]).toMatchObject({ direction: "to_patient" });
    expect(answer.coverage).toStrictEqual([
      expect.objectContaining({ healthSystemId: HEALTH_SYSTEM_A, status: "ok" }),
      expect.objectContaining({ healthSystemId: HEALTH_SYSTEM_B, status: "ok" }),
    ]);
  });

  it("answers a message both portals show once, from the health system it belongs to", async () => {
    const shared = { sent: "2026-03-01T10:00:00.000Z", body: "The same invented text." };
    store(HEALTH_SYSTEM_A, [record({ ...shared, external: true })]);
    store(HEALTH_SYSTEM_B, [record(shared)]);

    const answer = await callTool(world.client, "get_messages");

    expect(answer.items).toHaveLength(1);
    expect(answer.items[0]).toMatchObject({ healthSystemId: HEALTH_SYSTEM_B, firstParty: true });
    expect(answer.items[0]).not.toHaveProperty("via");
  });

  it("keeps a message only one portal shows, and a second-hand copy with no first-party one", async () => {
    store(HEALTH_SYSTEM_A, [
      record({ sent: "2026-03-01T10:00:00.000Z", role: "system", body: "An invented notice." }),
      record({ sent: "2026-03-03T10:00:00.000Z", external: true, body: "From elsewhere." }),
    ]);
    store(HEALTH_SYSTEM_B, []);

    const answer = await callTool(world.client, "get_messages");

    expect(answer.items).toHaveLength(2);
    expect(answer.items[0]).toMatchObject({
      firstParty: false,
      via: HEALTH_SYSTEM_A,
      organization: "Elsewhere Example Group",
    });
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

    expect(answer.items).toHaveLength(4);
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

    expect(answer.items.map((item) => item.body)).toStrictEqual(["A's own."]);
    expect(answer.coverage?.map((entry) => entry.healthSystemId)).toStrictEqual([HEALTH_SYSTEM_A]);
  });

  it("answers from only the health systems asked for, the copy belonging where it belongs", async () => {
    const shared = { sent: "2026-03-01T10:00:00.000Z", body: "Belongs to B." };
    store(HEALTH_SYSTEM_A, [record({ ...shared, external: true })]);
    store(HEALTH_SYSTEM_B, [record(shared)]);

    const onlyA = await callTool(world.client, "get_messages", { healthSystems: [NAME_A] });

    expect(onlyA.items).toStrictEqual([]);
  });

  it("windows on sent, and filters by folder, direction and thread", async () => {
    store(HEALTH_SYSTEM_A, [
      record({ sent: "2026-01-15T10:00:00.000Z", role: "patient" }),
      record({ sent: "2026-02-15T10:00:00.000Z", folder: "automated", thread: "thread-auto" }),
      record({ sent: "2026-03-15T10:00:00.000Z" }),
    ]);

    const february = await callTool(world.client, "get_messages", {
      from: "2026-02-01",
      to: "2026-02-28",
    });
    const automated = await callTool(world.client, "get_messages", { folder: "automated" });
    const sent = await callTool(world.client, "get_messages", { direction: "from_patient" });
    const thread = await callTool(world.client, "get_messages", { threadId: "thread-1" });

    expect(february.items.map((item) => item.sent)).toStrictEqual(["2026-02-15T10:00:00.000Z"]);
    expect(automated.items).toHaveLength(1);
    expect(sent.items.map((item) => item.sent)).toStrictEqual(["2026-01-15T10:00:00.000Z"]);
    expect(thread.items).toHaveLength(2);
  });

  it("marks a message its own portal stopped listing", async () => {
    store(HEALTH_SYSTEM_A, [record({ sent: "2026-03-01T10:00:00.000Z", missing: true })]);

    const answer = await callTool(world.client, "get_messages");

    expect(answer.items[0]).toMatchObject({ noLongerListed: true });
  });
});

describe("get_messages under the owner's name rules", () => {
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

  it("removes clinicians' and the patient's names but keeps the message", async () => {
    store(HEALTH_SYSTEM_A, [
      record({ sent: "2026-03-01T10:00:00.000Z", role: "patient", author: "Test Person" }),
      record({ sent: "2026-03-02T10:00:00.000Z", author: "Nurse Example A" }),
      record({ sent: "2026-03-03T10:00:00.000Z", role: "system", author: "Messaging System" }),
    ]);
    world.state.rules = OWNER_RULES;

    const answer = await callTool(world.client, "get_messages");

    expect(answer.text).not.toContain("Test Person");
    expect(answer.text).not.toContain("Nurse Example A");
    const [system, practitioner, patient] = answer.items;
    expect(practitioner?.from).toStrictEqual({ role: "practitioner" });
    expect(patient?.from).toStrictEqual({ role: "patient" });
    // Nobody's name: a system sender is the organisation's own mailbox.
    expect(system?.from).toStrictEqual({ role: "system", name: "Messaging System" });
    expect(practitioner).not.toHaveProperty("practitioners");
    expect(practitioner?.body).toBe("Invented text sent 2026-03-02T10:00:00.000Z");
    expect(practitioner?.subject).toBe("Invented subject");
  });

  it("removes clinicians' names wherever a rule withholds them from another record", async () => {
    store(HEALTH_SYSTEM_A, [
      record({ sent: "2026-03-02T10:00:00.000Z", author: "Nurse Example A" }),
    ]);
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

  it("removes every message, and the coverage, on a Communication resource rule", async () => {
    store(HEALTH_SYSTEM_A, [record({ sent: "2026-03-02T10:00:00.000Z" })]);
    world.state.rules = rules({ rule_type: "resource", target: "Communication" });

    const answer = await callTool(world.client, "get_messages");

    expect(answer.items).toStrictEqual([]);
    expect(answer.coverage).toStrictEqual([]);
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
  it("answers one conversation oldest first, and says when there is no such thread", async () => {
    store(HEALTH_SYSTEM_A, [
      record({ sent: "2026-03-02T10:00:00.000Z" }),
      record({ sent: "2026-03-01T10:00:00.000Z", role: "patient" }),
      record({ thread: "thread-2", sent: "2026-03-05T10:00:00.000Z" }),
    ]);

    const thread = await callTool(world.client, "get_message_thread", { threadId: "thread-1" });
    const none = await callTool(world.client, "get_message_thread", { threadId: "no-such" });

    expect(thread.items.map((item) => item.sent)).toStrictEqual([
      "2026-03-01T10:00:00.000Z",
      "2026-03-02T10:00:00.000Z",
    ]);
    expect(none.items).toStrictEqual([]);
    expect(none.warnings).toContain("thread_not_found");
  });

  it("requires a thread id", async () => {
    const answer = await callTool(world.client, "get_message_thread");

    expect(answer.isError).toBe(true);
  });
});
