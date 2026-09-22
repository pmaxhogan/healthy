import { beforeEach, describe, expect, it } from "vitest";

import {
  OTHER_DATA_KEY,
  T0,
  clock,
  column,
  rawColumn,
  resetDb,
  seedProvider,
  testRepos,
} from "./helpers.ts";

import type { CacheableResource } from "../../../worker/db/repos/fhir-cache.ts";

beforeEach(resetDb);

const DAY_MS = 86_400_000;

/**
 * Synthetic resources. Nothing here comes from a real record: the ids, the
 * timestamps and the one distinctive string are invented so the plaintext test
 * below has something unmistakable to look for.
 */
function encounter(id: string, lastUpdated?: string): CacheableResource {
  return {
    resourceType: "Encounter",
    id,
    ...(lastUpdated !== undefined && { meta: { lastUpdated } }),
    status: "planned",
    period: { start: "2026-02-01T15:30:00Z" },
    serviceType: { text: "distinctivevisittype" },
  };
}

describe("fhir_cache.upsertMany", () => {
  it("seals the payload and reads it back as JSON", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);

    const report = await repos.fhirCache.upsertMany(providerId, [encounter("e1")], DAY_MS);

    expect(report).toStrictEqual({ written: 1, unchanged: 0 });

    const cached = await repos.fhirCache.get(providerId, "Encounter", "e1");

    expect(cached?.resource).toStrictEqual(encounter("e1"));
    expect(cached?.fetchedAt).toBe(T0);

    const raw = await rawColumn(
      "fhir_cache",
      "payload_enc",
      "provider_id = ? AND resource_type = ? AND resource_id = ?",
      providerId,
      "Encounter",
      "e1",
    );

    expect(raw?.startsWith("v1:")).toBe(true);
    expect(raw).not.toContain("distinctivevisittype");
    expect(raw).not.toContain("Encounter");
  });

  it("records meta.lastUpdated as a unix second, and null when it is absent or junk", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);

    await repos.fhirCache.upsertMany(
      providerId,
      [
        encounter("with", "2026-02-01T00:00:00Z"),
        encounter("without"),
        { resourceType: "Encounter", id: "junk", meta: { lastUpdated: "yesterday" } },
      ],
      DAY_MS,
    );

    await expect(repos.fhirCache.get(providerId, "Encounter", "with")).resolves.toMatchObject({
      lastUpdated: 1_769_904_000,
    });
    await expect(repos.fhirCache.get(providerId, "Encounter", "without")).resolves.toMatchObject({
      lastUpdated: null,
    });
    await expect(repos.fhirCache.get(providerId, "Encounter", "junk")).resolves.toMatchObject({
      lastUpdated: null,
    });
  });

  it("counts an unchanged resource as unchanged and only extends its expiry", async () => {
    // Sealing is randomised, so the ciphertext cannot be compared; the plaintext
    // hash is what makes a no-op refresh cheap and its count meaningful.
    const time = clock();
    const repos = testRepos({ now: time.now });
    const providerId = await seedProvider(repos);

    await repos.fhirCache.upsertMany(providerId, [encounter("e1")], DAY_MS);
    const before = await rawColumn(
      "fhir_cache",
      "payload_enc",
      "provider_id = ? AND resource_id = ?",
      providerId,
      "e1",
    );

    time.advance(3600);
    const report = await repos.fhirCache.upsertMany(providerId, [encounter("e1")], DAY_MS);

    expect(report).toStrictEqual({ written: 0, unchanged: 1 });
    expect(
      await rawColumn(
        "fhir_cache",
        "payload_enc",
        "provider_id = ? AND resource_id = ?",
        providerId,
        "e1",
      ),
    ).toBe(before);
    await expect(repos.fhirCache.get(providerId, "Encounter", "e1")).resolves.toMatchObject({
      fetchedAt: T0 + 3600,
    });
  });

  it("rewrites a resource whose content changed", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);

    await repos.fhirCache.upsertMany(providerId, [encounter("e1")], DAY_MS);
    const changed = { ...encounter("e1"), status: "finished" };
    const report = await repos.fhirCache.upsertMany(providerId, [changed], DAY_MS);

    expect(report).toStrictEqual({ written: 1, unchanged: 0 });
    expect(await repos.fhirCache.get(providerId, "Encounter", "e1")).toMatchObject({
      resource: changed,
    });
  });

  it("handles a batch larger than one D1 batch", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    const many = Array.from({ length: 130 }, (_unused, index) => encounter(`e${String(index)}`));

    expect(await repos.fhirCache.upsertMany(providerId, many, DAY_MS)).toStrictEqual({
      written: 130,
      unchanged: 0,
    });
    expect(await repos.fhirCache.listByType(providerId, "Encounter", { limit: 200 })).toHaveLength(
      130,
    );
  });

  it("does nothing, cheaply, for an empty page", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);

    expect(await repos.fhirCache.upsertMany(providerId, [], DAY_MS)).toStrictEqual({
      written: 0,
      unchanged: 0,
    });
  });

  it("cannot open a payload moved to another provider's row", async () => {
    // The AAD is providerId:type:id, so a payload replanted under another
    // provider -- another patient -- is inert.
    const repos = testRepos();
    const first = await seedProvider(repos, { displayName: "A Example Health" });
    const second = await seedProvider(repos, { displayName: "B Example Health" });
    await repos.fhirCache.upsertMany(first, [encounter("e1")], DAY_MS);
    await repos.fhirCache.upsertMany(second, [encounter("e1")], DAY_MS);

    const stolen = await rawColumn(
      "fhir_cache",
      "payload_enc",
      "provider_id = ? AND resource_id = ?",
      first,
      "e1",
    );
    await repos.ctx.db
      .prepare("UPDATE fhir_cache SET payload_enc = ? WHERE provider_id = ? AND resource_id = ?")
      .bind(stolen, second, "e1")
      .run();

    await expect(repos.fhirCache.get(second, "Encounter", "e1")).rejects.toMatchObject({
      code: "crypto",
    });
  });

  it("cannot open a payload with the wrong key", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    await repos.fhirCache.upsertMany(providerId, [encounter("e1")], DAY_MS);

    await expect(
      testRepos({ dataKey: OTHER_DATA_KEY }).fhirCache.get(providerId, "Encounter", "e1"),
    ).rejects.toMatchObject({ code: "crypto" });
  });
});

describe("fhir_cache.listByType", () => {
  it("reads across providers when asked for all of them", async () => {
    const repos = testRepos();
    const first = await seedProvider(repos, { displayName: "A Example Health" });
    const second = await seedProvider(repos, { displayName: "B Example Health" });
    await repos.fhirCache.upsertMany(first, [encounter("e1")], DAY_MS);
    await repos.fhirCache.upsertMany(second, [encounter("e2")], DAY_MS);

    expect(await repos.fhirCache.listByType(null, "Encounter")).toHaveLength(2);
    expect(await repos.fhirCache.listByType(first, "Encounter")).toHaveLength(1);
    expect(await repos.fhirCache.listByType(null, "Condition")).toStrictEqual([]);
  });

  it("filters on `since` against lastUpdated, falling back to fetchedAt", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);

    await repos.fhirCache.upsertMany(
      providerId,
      [encounter("old", "2025-01-01T00:00:00Z"), encounter("new", "2026-06-01T00:00:00Z")],
      DAY_MS,
    );

    const recent = await repos.fhirCache.listByType(providerId, "Encounter", {
      since: 1_767_225_600,
    });

    expect(recent.map((row) => row.resourceId)).toStrictEqual(["new"]);
  });

  it("honours the limit", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    await repos.fhirCache.upsertMany(
      providerId,
      Array.from({ length: 10 }, (_unused, index) => encounter(`e${String(index)}`)),
      DAY_MS,
    );

    expect(await repos.fhirCache.listByType(providerId, "Encounter", { limit: 3 })).toHaveLength(3);
  });
});

describe("fhir_cache expiry", () => {
  it("hides an expired row from get and listByType before anything purges it", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const providerId = await seedProvider(repos);
    await repos.fhirCache.upsertMany(providerId, [encounter("e1")], DAY_MS);

    time.advance(86_401);

    expect(await repos.fhirCache.get(providerId, "Encounter", "e1")).toBeNull();
    expect(await repos.fhirCache.listByType(providerId, "Encounter")).toStrictEqual([]);
    expect(await repos.fhirCache.countsByType()).toStrictEqual([]);
  });

  it("purges only what has expired", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const providerId = await seedProvider(repos);

    await repos.fhirCache.upsertMany(providerId, [encounter("short")], 60_000);
    time.advance(120);
    await repos.fhirCache.upsertMany(providerId, [encounter("long")], DAY_MS);

    expect(await repos.fhirCache.purgeExpired()).toBe(1);
    expect(
      await column(repos.fhirCache.listByType(providerId, "Encounter"), "resourceId"),
    ).toStrictEqual(["long"]);
  });
});

describe("fhir_cache stats and clearing", () => {
  it("counts live rows per provider and type", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    await repos.fhirCache.upsertMany(
      providerId,
      [
        encounter("e1"),
        encounter("e2"),
        { resourceType: "Condition", id: "c1", code: { text: "synthetic" } },
      ],
      DAY_MS,
    );

    expect(await repos.fhirCache.countsByType()).toStrictEqual([
      { providerId, resourceType: "Condition", count: 1 },
      { providerId, resourceType: "Encounter", count: 2 },
    ]);
  });

  it("clears one provider's cache and cascades on provider delete", async () => {
    const repos = testRepos();
    const first = await seedProvider(repos, { displayName: "A Example Health" });
    const second = await seedProvider(repos, { displayName: "B Example Health" });
    await repos.fhirCache.upsertMany(first, [encounter("e1")], DAY_MS);
    await repos.fhirCache.upsertMany(second, [encounter("e1")], DAY_MS);

    expect(await repos.fhirCache.clearProvider(first)).toBe(1);
    expect(await repos.fhirCache.listByType(null, "Encounter")).toHaveLength(1);

    await repos.ctx.db.prepare("DELETE FROM providers WHERE id = ?").bind(second).run();

    expect(await repos.fhirCache.listByType(null, "Encounter")).toStrictEqual([]);
  });
});

describe("fhir_sync_state", () => {
  it("records the outcome per provider and resource type", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const providerId = await seedProvider(repos);

    await repos.fhirSyncState.record(providerId, "Encounter", { ok: true });
    time.advance(60);
    await repos.fhirSyncState.record(providerId, "Observation", {
      ok: false,
      errorCode: "upstream_error",
      warnings: [{ code: "4119", count: 2 }],
    });

    expect(await repos.fhirSyncState.get(providerId, "Encounter")).toStrictEqual({
      providerId,
      resourceType: "Encounter",
      lastFullAt: T0,
      lastOk: true,
      lastErrorCode: null,
      warnings: [],
    });
    expect(await repos.fhirSyncState.get(providerId, "Observation")).toStrictEqual({
      providerId,
      resourceType: "Observation",
      lastFullAt: T0 + 60,
      lastOk: false,
      lastErrorCode: "upstream_error",
      warnings: [{ code: "4119", count: 2 }],
    });
  });

  it("replaces the previous outcome rather than accumulating rows", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);

    await repos.fhirSyncState.record(providerId, "Encounter", {
      ok: false,
      errorCode: "upstream_error",
    });
    await repos.fhirSyncState.record(providerId, "Encounter", { ok: true });

    expect(await repos.fhirSyncState.listByProvider(providerId)).toHaveLength(1);
    await expect(repos.fhirSyncState.get(providerId, "Encounter")).resolves.toMatchObject({
      lastErrorCode: null,
    });
  });

  it("returns null for a pair it has never recorded, and lists everything", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);

    expect(await repos.fhirSyncState.get(providerId, "Goal")).toBeNull();

    await repos.fhirSyncState.record(providerId, "Encounter", { ok: true });

    expect(await repos.fhirSyncState.list()).toHaveLength(1);
  });
});
