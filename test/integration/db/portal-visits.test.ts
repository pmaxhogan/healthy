// `portal_visits`, against the real schema and real WebCrypto.
//
// What matters: the payload is sealed and bound to its own provider and CSN, an
// unchanged visit is not re-sealed, a future visit that stops being returned is
// marked missing (and comes back), a past one is left alone, and old rows go on
// the scheduled purge. Every visit is synthetic.

import { beforeEach, describe, expect, it } from "vitest";

import { aadFor, open } from "../../../worker/db/crypto.ts";

import {
  OTHER_DATA_KEY,
  T0,
  clock,
  rawColumn,
  resetDb,
  seedProvider,
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

type Repos = ReturnType<typeof testRepos>;

/** One stored visit by CSN, or undefined. */
async function storedVisit(repos: Repos, providerId: string, csn: string) {
  const rows = await repos.portalVisits.list(providerId);
  return rows.find((row) => row.csn === csn);
}

describe("portal_visits.record", () => {
  it("seals the payload and reads it back", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);

    const report = await repos.portalVisits.record(providerId, [visit("csn-1", DAY)], COMPLETE);

    expect(report).toStrictEqual({ written: 1, unchanged: 0, missing: 0 });
    const [stored] = await repos.portalVisits.list(providerId);
    expect(stored).toStrictEqual({
      providerId,
      csn: "csn-1",
      visit: visit("csn-1", DAY),
      state: "active",
      missingSince: null,
      fetchedAt: T0,
    });

    const sealed = await rawColumn(
      "portal_visits",
      "payload_enc",
      "provider_id = ? AND csn = ?",
      providerId,
      "csn-1",
    );
    expect(sealed?.startsWith("v1:")).toBe(true);
    expect(sealed).not.toContain("distinctivepractitioner");
    // The AAD is `portal_visits.payload_enc.<providerId>:<csn>`.
    const opened = await open(
      repos.ctx.env,
      sealed ?? "",
      aadFor("portal_visits", "payload_enc", `${providerId}:csn-1`),
    );
    expect(JSON.parse(opened)).toStrictEqual(visit("csn-1", DAY));
  });

  it("cannot open a payload moved onto another visit's row, or another provider's", async () => {
    const repos = testRepos();
    const first = await seedProvider(repos, { displayName: "A Example Health" });
    const second = await seedProvider(repos, { displayName: "B Example Health" });
    await repos.portalVisits.record(
      first,
      [visit("csn-1", DAY), visit("csn-2", 2 * DAY)],
      COMPLETE,
    );
    await repos.portalVisits.record(second, [visit("csn-1", DAY)], COMPLETE);

    const stolen = await rawColumn(
      "portal_visits",
      "payload_enc",
      "provider_id = ? AND csn = ?",
      first,
      "csn-1",
    );
    await repos.ctx.db
      .prepare("UPDATE portal_visits SET payload_enc = ? WHERE provider_id = ? AND csn = ?")
      .bind(stolen, second, "csn-1")
      .run();
    await expect(repos.portalVisits.list(second)).rejects.toMatchObject({ code: "crypto" });

    await repos.ctx.db
      .prepare("UPDATE portal_visits SET payload_enc = ? WHERE provider_id = ? AND csn = ?")
      .bind(stolen, first, "csn-2")
      .run();
    await expect(repos.portalVisits.list(first)).rejects.toMatchObject({ code: "crypto" });
  });

  it("cannot open a payload with the wrong key", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    await repos.portalVisits.record(providerId, [visit("csn-1", DAY)], COMPLETE);

    await expect(
      testRepos({ dataKey: OTHER_DATA_KEY }).portalVisits.list(providerId),
    ).rejects.toMatchObject({ code: "crypto" });
  });

  it("only moves the timestamps of an unchanged visit, and rewrites a changed one", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const providerId = await seedProvider(repos);
    await repos.portalVisits.record(providerId, [visit("csn-1", 5 * DAY)], COMPLETE);
    const before = await rawColumn("portal_visits", "payload_enc", "csn = ?", "csn-1");

    time.advance(3600);
    const unchanged = await repos.portalVisits.record(
      providerId,
      [visit("csn-1", 5 * DAY)],
      COMPLETE,
    );
    expect(unchanged).toStrictEqual({ written: 0, unchanged: 1, missing: 0 });
    expect(await rawColumn("portal_visits", "payload_enc", "csn = ?", "csn-1")).toBe(before);
    const touched = await storedVisit(repos, providerId, "csn-1");
    expect(touched?.fetchedAt).toBe(T0 + 3600);

    const changed = await repos.portalVisits.record(
      providerId,
      [visit("csn-1", 6 * DAY, { visitType: "Annual physical" })],
      COMPLETE,
    );
    expect(changed.written).toBe(1);
    const [row] = await repos.portalVisits.list(providerId);
    expect(row?.visit.visitType).toBe("Annual physical");
    expect(await rawColumn("portal_visits", "start_at", "csn = ?", "csn-1")).toBe(T0 + 6 * DAY);
  });

  it("marks a future visit that stopped being returned as missing, and restores it", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const providerId = await seedProvider(repos);
    await repos.portalVisits.record(
      providerId,
      [visit("csn-keep", 2 * DAY), visit("csn-gone", 3 * DAY)],
      COMPLETE,
    );

    time.advance(3600);
    const report = await repos.portalVisits.record(
      providerId,
      [visit("csn-keep", 2 * DAY)],
      COMPLETE,
    );

    expect(report.missing).toBe(1);
    const gone = await storedVisit(repos, providerId, "csn-gone");
    expect(gone).toMatchObject({ state: "missing", missingSince: T0 + 3600 });

    // A second run without it does not move `missing_since`.
    time.advance(3600);
    await repos.portalVisits.record(providerId, [visit("csn-keep", 2 * DAY)], COMPLETE);
    const still = await storedVisit(repos, providerId, "csn-gone");
    expect(still?.missingSince).toBe(T0 + 3600);

    await repos.portalVisits.record(
      providerId,
      [visit("csn-keep", 2 * DAY), visit("csn-gone", 3 * DAY)],
      COMPLETE,
    );
    const back = await storedVisit(repos, providerId, "csn-gone");
    expect(back).toMatchObject({ state: "active", missingSince: null });
  });

  it("leaves a visit alone once its start has passed, however it disappears", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const providerId = await seedProvider(repos);
    await repos.portalVisits.record(providerId, [visit("csn-1", 3600)], COMPLETE);

    time.advance(2 * 3600);
    const report = await repos.portalVisits.record(providerId, [], COMPLETE);

    expect(report.missing).toBe(0);
    const kept = await storedVisit(repos, providerId, "csn-1");
    expect(kept?.state).toBe("active");
  });

  it("marks nothing missing from a list known to be incomplete", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    await repos.portalVisits.record(providerId, [visit("csn-1", DAY)], COMPLETE);

    const report = await repos.portalVisits.record(providerId, [], { complete: false });

    expect(report.missing).toBe(0);
    const kept = await storedVisit(repos, providerId, "csn-1");
    expect(kept?.state).toBe("active");
  });
});

describe("portal_visits retention", () => {
  it("purges a visit a year after it happened, and not before", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const providerId = await seedProvider(repos);
    await repos.portalVisits.record(providerId, [visit("csn-1", DAY)], COMPLETE);

    time.advance(300 * DAY);
    expect(await repos.portalVisits.purgeExpired()).toBe(0);
    expect(await repos.portalVisits.list(providerId)).toHaveLength(1);

    time.advance(70 * DAY);
    expect(await repos.portalVisits.list(providerId)).toStrictEqual([]);
    expect(await repos.portalVisits.purgeExpired()).toBe(1);
  });

  it("forgets one provider's visits on request, and nobody else's", async () => {
    const repos = testRepos();
    const first = await seedProvider(repos, { displayName: "A Example Health" });
    const second = await seedProvider(repos, { displayName: "B Example Health" });
    await repos.portalVisits.record(first, [visit("csn-1", DAY)], COMPLETE);
    await repos.portalVisits.record(second, [visit("csn-2", DAY)], COMPLETE);

    expect(await repos.portalVisits.clearProvider(first)).toBe(1);
    expect(await repos.portalVisits.list(first)).toStrictEqual([]);
    expect(await repos.portalVisits.list(second)).toHaveLength(1);
  });
});
