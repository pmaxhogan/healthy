// `portal_messages` and `portal_message_sync`, against the real schema and real
// WebCrypto.
//
// What matters: a message is sealed (padded) and bound to its own row, nothing
// readable is in the clear, keys come from content and not from the portal's
// per-session ids, an unchanged message is not re-sealed, a first-party message
// the portal stops listing is flagged -- never deleted -- while a second-hand one
// is left alone, one message two portals show gets the same public ids from both,
// and deleting a health system's messages takes the sync row too. Every message
// is synthetic.

import { beforeEach, describe, expect, it } from "vitest";

import { aadFor, open } from "../../../src/db/crypto.ts";

import {
  OTHER_DATA_KEY,
  clock,
  rawColumn,
  resetDb,
  seedHealthSystem,
  testRepos,
} from "./helpers.ts";

import type { PortalThread } from "../../../src/ehr/mychart/index.ts";

beforeEach(resetDb);

/** A copy, sorted. */
function sorted(values: readonly string[]): string[] {
  // eslint-disable-next-line unicorn/no-array-sort -- Array#toSorted is ES2023 and the integration project compiles against the Worker's ES2022 lib; this sorts a fresh copy.
  return [...values].sort((a, b) => a.localeCompare(b));
}

const BODY = "distinctivebodytext about a refill";

function thread(overrides: Partial<PortalThread> = {}): PortalThread {
  return {
    subject: "Invented subject",
    folder: "conversations",
    external: false,
    practitioners: [{ name: "Nurse Example A" }],
    messages: [
      {
        sent: "2026-03-01T10:00:00.000Z",
        role: "patient",
        author: "Test Person",
        body: BODY,
        attachments: [],
      },
      {
        sent: "2026-03-01T12:00:00.000Z",
        role: "practitioner",
        author: "Nurse Example A",
        body: "An invented reply.",
        attachments: [{ name: "invented-sheet", extension: "PDF" }],
      },
    ],
    ...overrides,
  };
}

const COMPLETE = { complete: true };

describe("portal_messages.record", () => {
  it("seals every message padded, bound to its row, with nothing readable in the clear", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);

    const report = await repos.portalMessages.record(healthSystemId, [thread()], COMPLETE);

    expect(report).toStrictEqual({ written: 2, unchanged: 0, missing: 0, attachments: [] });
    const rows = await repos.ctx.db
      .prepare("SELECT * FROM portal_messages WHERE health_system_id = ?")
      .bind(healthSystemId)
      .all();
    expect(rows.results).toHaveLength(2);
    const dump = JSON.stringify(rows.results);
    expect(dump).not.toContain("distinctivebodytext");
    expect(dump).not.toContain("Invented subject");
    expect(dump).not.toContain("Nurse Example");
    for (const row of rows.results) {
      expect(String(row.payload_enc)).toMatch(/^v2:/u);
      expect(String(row.message_key)).toMatch(/^~/u);
      expect(String(row.thread_key)).toMatch(/^~/u);
      const opened = await open(
        repos.ctx.env,
        String(row.payload_enc),
        aadFor("portal_messages", "payload_enc", `${healthSystemId}:${String(row.message_key)}`),
      );
      expect(JSON.parse(opened)).toHaveProperty("thread.subject", "Invented subject");
    }

    const stored = await repos.portalMessages.list(healthSystemId);
    expect(sorted(stored.map((row) => row.message.body))).toStrictEqual(
      sorted(["An invented reply.", BODY]),
    );
    const threadIds = new Set(stored.map((row) => row.threadId));
    expect(threadIds.size).toBe(1);
    expect(stored.every((row) => !row.missing)).toBe(true);
  });

  it("cannot open a payload moved onto another row, or with the wrong key", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);
    await repos.portalMessages.record(healthSystemId, [thread()], COMPLETE);
    const rows = await repos.ctx.db
      .prepare("SELECT message_key, payload_enc FROM portal_messages")
      .all<{ message_key: string; payload_enc: string }>();
    const [first, second] = rows.results;

    await expect(
      testRepos({ dataKey: OTHER_DATA_KEY }).portalMessages.list(healthSystemId),
    ).rejects.toMatchObject({ code: "crypto" });

    await repos.ctx.db
      .prepare("UPDATE portal_messages SET payload_enc = ? WHERE message_key = ?")
      .bind(first?.payload_enc, second?.message_key)
      .run();
    await expect(repos.portalMessages.list(healthSystemId)).rejects.toMatchObject({
      code: "crypto",
    });
  });

  it("leaves an unchanged message alone and rewrites a changed one", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const healthSystemId = await seedHealthSystem(repos);
    await repos.portalMessages.record(healthSystemId, [thread()], COMPLETE);
    const before = await rawColumn("portal_messages", "payload_enc", "1 = 1 ORDER BY message_key");

    time.advance(3600);
    const again = await repos.portalMessages.record(healthSystemId, [thread()], COMPLETE);
    expect(again).toStrictEqual({ written: 0, unchanged: 2, missing: 0, attachments: [] });
    expect(await rawColumn("portal_messages", "payload_enc", "1 = 1 ORDER BY message_key")).toBe(
      before,
    );

    // Moved to the archive: the same messages, a changed thread.
    const moved = await repos.portalMessages.record(
      healthSystemId,
      [thread({ folder: "archive" })],
      COMPLETE,
    );
    expect(moved).toStrictEqual({ written: 2, unchanged: 0, missing: 0, attachments: [] });
    const stored = await repos.portalMessages.list(healthSystemId);
    expect(stored.every((row) => row.thread.folder === "archive")).toBe(true);
  });

  it("flags a first-party message the portal stopped listing, and unflags it when it is back", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);
    await repos.portalMessages.record(healthSystemId, [thread()], COMPLETE);

    const gone = await repos.portalMessages.record(healthSystemId, [], COMPLETE);
    expect(gone.missing).toBe(2);
    const flagged = await repos.portalMessages.list(healthSystemId);
    expect(flagged).toHaveLength(2);
    expect(flagged.every((row) => row.missing)).toBe(true);

    await repos.portalMessages.record(healthSystemId, [thread()], COMPLETE);
    const back = await repos.portalMessages.list(healthSystemId);
    expect(back.every((row) => !row.missing)).toBe(true);
  });

  it("never flags a second-hand message, nor anything after an incomplete read", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);
    await repos.portalMessages.record(
      healthSystemId,
      [
        thread({ external: true, organization: "Other Example Clinic" }),
        thread({ subject: "Own" }),
      ],
      COMPLETE,
    );

    const incomplete = await repos.portalMessages.record(healthSystemId, [], { complete: false });
    expect(incomplete.missing).toBe(0);
    const complete = await repos.portalMessages.record(healthSystemId, [], COMPLETE);
    // Only the first-party thread's two messages.
    expect(complete.missing).toBe(2);
    const stored = await repos.portalMessages.list(healthSystemId);
    expect(stored.filter((row) => row.missing)).toHaveLength(2);
    expect(stored.filter((row) => row.thread.external && row.missing)).toHaveLength(0);
  });

  it("gives one message the same public ids and fingerprint from two portals", async () => {
    const repos = testRepos();
    const first = await seedHealthSystem(repos, { displayName: "A Example Health" });
    const second = await seedHealthSystem(repos, { displayName: "B Example Health" });
    await repos.portalMessages.record(first, [thread()], COMPLETE);
    await repos.portalMessages.record(
      second,
      [thread({ external: true, organization: "A Example Health" })],
      COMPLETE,
    );

    const a = await repos.portalMessages.list(first);
    const b = await repos.portalMessages.list(second);
    const ids = (rows: typeof a): string[] => sorted(rows.map((row) => row.messageId));
    expect(ids(b)).toStrictEqual(ids(a));
    expect(sorted(b.map((row) => row.fingerprint))).toStrictEqual(
      sorted(a.map((row) => row.fingerprint)),
    );
    // The stored keys are per health system, so a snapshot cannot link the two.
    const keys = await repos.ctx.db
      .prepare("SELECT DISTINCT message_key FROM portal_messages")
      .all<{ message_key: string }>();
    expect(keys.results).toHaveLength(4);
  });

  it("tells near-duplicates apart: same second with other text, same text a second later", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);
    const base = thread().messages[0];
    if (base === undefined) throw new Error("fixture has a first message");
    await repos.portalMessages.record(
      healthSystemId,
      [
        thread({
          messages: [
            base,
            { ...base, body: `${BODY} (edited)` },
            { ...base, sent: "2026-03-01T10:00:01.000Z" },
          ],
        }),
      ],
      COMPLETE,
    );

    const stored = await repos.portalMessages.list(healthSystemId);
    expect(new Set(stored.map((row) => row.fingerprint)).size).toBe(3);
  });
});

describe("portal_message_sync", () => {
  it("records a success, then a failure that keeps the last success", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const healthSystemId = await seedHealthSystem(repos);

    await repos.portalMessages.markSync(healthSystemId, {
      ok: true,
      complete: true,
      threads: 3,
      messages: 7,
    });
    const okAt = time.now();
    time.advance(3600);
    await repos.portalMessages.markSync(healthSystemId, {
      ok: false,
      errorCode: "portal_session_expired",
    });

    expect(await repos.portalMessages.listSync()).toStrictEqual([
      {
        healthSystemId,
        lastAttemptAt: time.now(),
        lastOkAt: okAt,
        lastErrorCode: "portal_session_expired",
        complete: true,
        threads: 3,
        messages: 7,
      },
    ]);
  });

  it("forgets a health system's messages and its sync row together", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);
    const other = await seedHealthSystem(repos, { displayName: "Other Example" });
    await repos.portalMessages.record(healthSystemId, [thread()], COMPLETE);
    await repos.portalMessages.record(other, [thread()], COMPLETE);
    await repos.portalMessages.markSync(healthSystemId, {
      ok: true,
      complete: true,
      threads: 1,
      messages: 2,
    });

    await expect(repos.portalMessages.clearHealthSystem(healthSystemId)).resolves.toBe(2);

    expect(await repos.portalMessages.list(healthSystemId)).toStrictEqual([]);
    expect(await repos.portalMessages.listSync()).toStrictEqual([]);
    expect(await repos.portalMessages.list(other)).toHaveLength(2);
  });
});
