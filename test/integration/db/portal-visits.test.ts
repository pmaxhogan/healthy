// `portal_visits`, against the real schema and real WebCrypto.
//
// What matters: the payload is sealed and bound to its own health system and CSN, an
// unchanged visit is not re-sealed, a future visit that stops being returned is
// marked missing (and comes back), a past one is left alone, and old rows go on
// the scheduled purge. Every visit is synthetic.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { blindCsn } from "../../../worker/db/blind.ts";
import { aadFor, open } from "../../../worker/db/crypto.ts";
import { EXPIRY_BUCKET_SECONDS } from "../../../worker/db/repos/portal-visits.ts";

import {
  OTHER_DATA_KEY,
  T0,
  clock,
  rawColumn,
  resetDb,
  seedHealthSystem,
  testBlinder,
  testRepos,
} from "./helpers.ts";

import type { PortalVisit } from "../../../worker/providers/mychart/index.ts";

beforeEach(resetDb);

const DAY = 86_400;

/** ISO for `T0 + seconds`. */
const at = (seconds: number): string => new Date((T0 + seconds) * 1000).toISOString();

function visit(
  csn: string,
  startOffset: number,
  overrides: Partial<PortalVisit> = {},
): PortalVisit {
  return {
    csn,
    start: at(startOffset),
    timeZone: "UTC",
    visitType: "Follow-up",
    practitioner: "distinctivepractitioner",
    department: "Example Clinic",
    isVideo: false,
    status: "scheduled",
    ...overrides,
  };
}

const COMPLETE = { complete: true };

/** The number a visit is stored under: its blind, never the portal's own. */
function storedCsn(healthSystemId: string, csn: string): Promise<string> {
  return blindCsn(testBlinder(), healthSystemId, csn);
}

type Repos = ReturnType<typeof testRepos>;

/** One stored visit by CSN, or undefined. */
async function storedVisit(repos: Repos, healthSystemId: string, csn: string) {
  const rows = await repos.portalVisits.list(healthSystemId);
  return rows.find((row) => row.csn === csn);
}

describe("portal_visits.record", () => {
  it("seals the payload and reads it back", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);

    const report = await repos.portalVisits.record(healthSystemId, [visit("csn-1", DAY)], COMPLETE);

    expect(report).toStrictEqual({ written: 1, unchanged: 0, missing: 0 });
    const [stored] = await repos.portalVisits.list(healthSystemId);
    expect(stored).toStrictEqual({
      healthSystemId,
      csn: "csn-1",
      visit: visit("csn-1", DAY),
      state: "active",
      missingSince: null,
      fetchedAt: T0,
    });

    const sealed = await rawColumn(
      "portal_visits",
      "payload_enc",
      "health_system_id = ? AND csn = ?",
      healthSystemId,
      await storedCsn(healthSystemId, "csn-1"),
    );
    expect(sealed ?? "").toMatch(/^v1:/u);
    expect(sealed).not.toContain("distinctivepractitioner");
    // The AAD is `portal_visits.payload_enc.<healthSystemId>:<stored csn>`.
    const opened = await open(
      repos.ctx.env,
      sealed ?? "",
      aadFor(
        "portal_visits",
        "payload_enc",
        `${healthSystemId}:${await storedCsn(healthSystemId, "csn-1")}`,
      ),
    );
    expect(JSON.parse(opened)).toStrictEqual(visit("csn-1", DAY));
  });

  it("cannot open a payload moved onto another visit's row, or another health system's", async () => {
    const repos = testRepos();
    const first = await seedHealthSystem(repos, { displayName: "A Example Health" });
    const second = await seedHealthSystem(repos, { displayName: "B Example Health" });
    await repos.portalVisits.record(
      first,
      [visit("csn-1", DAY), visit("csn-2", 2 * DAY)],
      COMPLETE,
    );
    await repos.portalVisits.record(second, [visit("csn-1", DAY)], COMPLETE);

    const stolen = await rawColumn(
      "portal_visits",
      "payload_enc",
      "health_system_id = ? AND csn = ?",
      first,
      await storedCsn(first, "csn-1"),
    );
    await repos.ctx.db
      .prepare("UPDATE portal_visits SET payload_enc = ? WHERE health_system_id = ? AND csn = ?")
      .bind(stolen, second, await storedCsn(second, "csn-1"))
      .run();
    await expect(repos.portalVisits.list(second)).rejects.toMatchObject({ code: "crypto" });

    await repos.ctx.db
      .prepare("UPDATE portal_visits SET payload_enc = ? WHERE health_system_id = ? AND csn = ?")
      .bind(stolen, first, await storedCsn(first, "csn-2"))
      .run();
    await expect(repos.portalVisits.list(first)).rejects.toMatchObject({ code: "crypto" });
  });

  it("cannot open a payload with the wrong key", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);
    await repos.portalVisits.record(healthSystemId, [visit("csn-1", DAY)], COMPLETE);

    await expect(
      testRepos({ dataKey: OTHER_DATA_KEY }).portalVisits.list(healthSystemId),
    ).rejects.toMatchObject({ code: "crypto" });
  });

  it("only moves the timestamps of an unchanged visit, and rewrites a changed one", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const healthSystemId = await seedHealthSystem(repos);
    await repos.portalVisits.record(healthSystemId, [visit("csn-1", 5 * DAY)], COMPLETE);
    const csn1 = await storedCsn(healthSystemId, "csn-1");
    const before = await rawColumn("portal_visits", "payload_enc", "csn = ?", csn1);

    time.advance(3600);
    const unchanged = await repos.portalVisits.record(
      healthSystemId,
      [visit("csn-1", 5 * DAY)],
      COMPLETE,
    );
    expect(unchanged).toStrictEqual({ written: 0, unchanged: 1, missing: 0 });
    expect(await rawColumn("portal_visits", "payload_enc", "csn = ?", csn1)).toBe(before);
    const touched = await storedVisit(repos, healthSystemId, "csn-1");
    expect(touched?.fetchedAt).toBe(T0 + 3600);

    const changed = await repos.portalVisits.record(
      healthSystemId,
      [visit("csn-1", 6 * DAY, { visitType: "Annual physical" })],
      COMPLETE,
    );
    expect(changed.written).toBe(1);
    const [row] = await repos.portalVisits.list(healthSystemId);
    expect(row?.visit.visitType).toBe("Annual physical");
    // The start moved with it, but only inside the payload: there is no column.
    expect(row?.visit.start).toBe(at(6 * DAY));
  });

  it("marks a future visit that stopped being returned as missing, and restores it", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const healthSystemId = await seedHealthSystem(repos);
    await repos.portalVisits.record(
      healthSystemId,
      [visit("csn-keep", 2 * DAY), visit("csn-gone", 3 * DAY)],
      COMPLETE,
    );

    time.advance(3600);
    const report = await repos.portalVisits.record(
      healthSystemId,
      [visit("csn-keep", 2 * DAY)],
      COMPLETE,
    );

    expect(report.missing).toBe(1);
    const gone = await storedVisit(repos, healthSystemId, "csn-gone");
    expect(gone).toMatchObject({ state: "missing", missingSince: T0 + 3600 });

    // A second run without it does not move `missing_since`.
    time.advance(3600);
    await repos.portalVisits.record(healthSystemId, [visit("csn-keep", 2 * DAY)], COMPLETE);
    const still = await storedVisit(repos, healthSystemId, "csn-gone");
    expect(still?.missingSince).toBe(T0 + 3600);

    await repos.portalVisits.record(
      healthSystemId,
      [visit("csn-keep", 2 * DAY), visit("csn-gone", 3 * DAY)],
      COMPLETE,
    );
    const back = await storedVisit(repos, healthSystemId, "csn-gone");
    expect(back).toMatchObject({ state: "active", missingSince: null });
  });

  it("leaves a visit alone once its start has passed, however it disappears", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const healthSystemId = await seedHealthSystem(repos);
    await repos.portalVisits.record(healthSystemId, [visit("csn-1", 3600)], COMPLETE);

    time.advance(2 * 3600);
    const report = await repos.portalVisits.record(healthSystemId, [], COMPLETE);

    expect(report.missing).toBe(0);
    const kept = await storedVisit(repos, healthSystemId, "csn-1");
    expect(kept?.state).toBe("active");
  });

  it("marks nothing missing from a list known to be incomplete", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);
    await repos.portalVisits.record(healthSystemId, [visit("csn-1", DAY)], COMPLETE);

    const report = await repos.portalVisits.record(healthSystemId, [], { complete: false });

    expect(report.missing).toBe(0);
    const kept = await storedVisit(repos, healthSystemId, "csn-1");
    expect(kept?.state).toBe("active");
  });
});

describe("portal_visits retention", () => {
  it("purges a visit a year after it happened, and not before", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const healthSystemId = await seedHealthSystem(repos);
    await repos.portalVisits.record(healthSystemId, [visit("csn-1", DAY)], COMPLETE);

    time.advance(300 * DAY);
    expect(await repos.portalVisits.purgeExpired()).toBe(0);
    expect(await repos.portalVisits.list(healthSystemId)).toHaveLength(1);

    // A year after the visit, rounded up to the next expiry bucket.
    time.advance(100 * DAY);
    expect(await repos.portalVisits.list(healthSystemId)).toStrictEqual([]);
    expect(await repos.portalVisits.purgeExpired()).toBe(1);
  });

  it("forgets one health system's visits on request, and nobody else's", async () => {
    const repos = testRepos();
    const first = await seedHealthSystem(repos, { displayName: "A Example Health" });
    const second = await seedHealthSystem(repos, { displayName: "B Example Health" });
    await repos.portalVisits.record(first, [visit("csn-1", DAY)], COMPLETE);
    await repos.portalVisits.record(second, [visit("csn-2", DAY)], COMPLETE);

    expect(await repos.portalVisits.clearHealthSystem(first)).toBe(1);
    expect(await repos.portalVisits.list(first)).toStrictEqual([]);
    expect(await repos.portalVisits.list(second)).toHaveLength(1);
  });
});

describe("what portal_visits stores", () => {
  it("keeps the visit number and the start out of every plaintext column", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);
    await repos.portalVisits.record(healthSystemId, [visit("csn-secret", DAY + 1234)], COMPLETE);

    const raw = await env.DB.prepare("SELECT * FROM portal_visits WHERE health_system_id = ?")
      .bind(healthSystemId)
      .first();
    const dump = JSON.stringify(raw);

    expect(dump).not.toContain("csn-secret");
    expect(raw?.csn).toBe(await storedCsn(healthSystemId, "csn-secret"));
    expect(raw).not.toHaveProperty("start_at");
    // The expiry is a bucket boundary, so it no longer dates the visit to the second.
    expect(Number(raw?.expires_at) % EXPIRY_BUCKET_SECONDS).toBe(0);
    expect(dump).not.toContain(String(T0 + DAY + 1234));
  });

  it("gives the same visit number under two health systems two unrelated stored values", async () => {
    const repos = testRepos();
    const first = await seedHealthSystem(repos, { displayName: "A Example Health" });
    const second = await seedHealthSystem(repos, { displayName: "B Example Health" });
    await repos.portalVisits.record(first, [visit("csn-1", DAY)], COMPLETE);
    await repos.portalVisits.record(second, [visit("csn-1", DAY)], COMPLETE);

    const rows = await env.DB.prepare("SELECT csn, content_hash FROM portal_visits").all<{
      csn: string;
      content_hash: string;
    }>();

    expect(new Set(rows.results.map((row) => row.csn)).size).toBe(2);
    expect(new Set(rows.results.map((row) => row.content_hash)).size).toBe(2);
  });

  it("still lists visits earliest first, from the sealed start", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);
    await repos.portalVisits.record(
      healthSystemId,
      [visit("csn-late", 3 * DAY), visit("csn-early", DAY), visit("csn-mid", 2 * DAY)],
      COMPLETE,
    );

    const listed = await repos.portalVisits.list(healthSystemId);

    expect(listed.map((row) => row.csn)).toStrictEqual(["csn-early", "csn-mid", "csn-late"]);
  });
});
