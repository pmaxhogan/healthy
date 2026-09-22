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

beforeEach(resetDb);

describe("connections.upsertTokens", () => {
  it("creates the row on first write and seals every secret column", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);

    const connection = await repos.connections.upsertTokens(providerId, {
      patientFhirId: "patient-identifier-one",
      accessToken: "access-token-one",
      refreshToken: "refresh-token-one",
      accessExpiresAt: T0 + 3600,
      scope: "patient/Encounter.read",
      status: "connected",
    });

    expect(connection.provider_id).toBe(providerId);
    expect(connection.status).toBe("connected");
    expect(connection.access_expires_at).toBe(T0 + 3600);
    expect(await repos.connections.getSecrets(connection.id)).toStrictEqual({
      patientFhirId: "patient-identifier-one",
      accessToken: "access-token-one",
      refreshToken: "refresh-token-one",
    });

    for (const column of ["patient_fhir_id_enc", "access_token_enc", "refresh_token_enc"]) {
      const raw = await rawColumn("connections", column, "id = ?", connection.id);

      expect(raw?.startsWith("v1:"), column).toBe(true);
      expect(raw, column).not.toContain("token-one");
      expect(raw, column).not.toContain("patient-identifier");
    }
  });

  it("reuses the same row, and the same id, on a second write", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);

    const first = await repos.connections.upsertTokens(providerId, { accessToken: "a" });
    const second = await repos.connections.upsertTokens(providerId, { accessToken: "b" });

    expect(second.id).toBe(first.id);
    await expect(repos.connections.getSecrets(first.id)).resolves.toMatchObject({
      accessToken: "b",
    });
    // The AAD is bound to the row id, so re-sealing against the reused id is the
    // only thing that keeps the second write openable.
    expect(await repos.connections.list()).toHaveLength(1);
  });

  it("leaves the columns it was not given alone", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);

    const connection = await repos.connections.upsertTokens(providerId, {
      accessToken: "access-1",
      refreshToken: "refresh-1",
    });
    await repos.connections.upsertTokens(providerId, { accessToken: "access-2" });

    expect(await repos.connections.getSecrets(connection.id)).toStrictEqual({
      patientFhirId: null,
      accessToken: "access-2",
      refreshToken: "refresh-1",
    });
  });

  it("cannot be opened with the wrong key", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    const connection = await repos.connections.upsertTokens(providerId, { accessToken: "a" });

    await expect(
      testRepos({ dataKey: OTHER_DATA_KEY }).connections.getSecrets(connection.id),
    ).rejects.toMatchObject({ code: "crypto" });
  });

  it("cannot have a token moved between its own columns", async () => {
    // The AAD includes the column, not just the row, so an access token pasted
    // into the refresh column does not open.
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    const connection = await repos.connections.upsertTokens(providerId, { accessToken: "a" });
    const sealed = await rawColumn("connections", "access_token_enc", "id = ?", connection.id);

    await repos.ctx.db
      .prepare("UPDATE connections SET refresh_token_enc = ? WHERE id = ?")
      .bind(sealed, connection.id)
      .run();

    await expect(repos.connections.getSecrets(connection.id)).rejects.toMatchObject({
      code: "crypto",
    });
  });
});

describe("the connection status machine", () => {
  it("records a re-auth need with its code, its clock and a failure count", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const providerId = await seedProvider(repos);
    const connection = await repos.connections.upsertTokens(providerId, { status: "connected" });

    expect(await repos.connections.markNeedsReauth(connection.id, "invalid_grant")).toBe(true);
    time.advance(3600);
    await repos.connections.markNeedsReauth(connection.id, "invalid_grant");

    const row = await repos.connections.get(connection.id);

    expect(row?.status).toBe("needs_reauth");
    expect(row?.last_error_code).toBe("invalid_grant");
    expect(row?.refresh_failures).toBe(2);
    // The clock records when it FIRST broke, which is what the Trello card quotes.
    expect(row?.needs_reauth_since).toBe(T0);
  });

  it("clears the error, the clock and the failure count on reconnect", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    const connection = await repos.connections.upsertTokens(providerId, {});
    await repos.connections.markNeedsReauth(connection.id, "invalid_grant");

    expect(await repos.connections.markConnected(connection.id)).toBe(true);

    const row = await repos.connections.get(connection.id);

    expect(row?.status).toBe("connected");
    expect(row?.last_error_code).toBeNull();
    expect(row?.needs_reauth_since).toBeNull();
    expect(row?.refresh_failures).toBe(0);
  });

  it("records a transient error without losing the tokens", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    const connection = await repos.connections.upsertTokens(providerId, { accessToken: "a" });

    expect(await repos.connections.markError(connection.id, "upstream_unavailable")).toBe(true);

    await expect(repos.connections.get(connection.id)).resolves.toMatchObject({ status: "error" });
    await expect(repos.connections.getSecrets(connection.id)).resolves.toMatchObject({
      accessToken: "a",
    });
  });

  it("forgets the tokens on disconnect but keeps the row", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    const connection = await repos.connections.upsertTokens(providerId, {
      accessToken: "a",
      refreshToken: "r",
      patientFhirId: "p",
    });

    expect(await repos.connections.disconnect(connection.id)).toBe(true);

    expect(await repos.connections.getSecrets(connection.id)).toStrictEqual({
      // The patient id survives: it is not a credential, and re-authorising the
      // same person should not have to rediscover it.
      patientFhirId: "p",
      accessToken: null,
      refreshToken: null,
    });
    await expect(repos.connections.get(connection.id)).resolves.toMatchObject({
      status: "disconnected",
    });
  });

  it("stamps the right clock per kind of sync", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const providerId = await seedProvider(repos);
    const connection = await repos.connections.upsertTokens(providerId, {});

    await repos.connections.recordSync(connection.id, "calendar");
    time.advance(600);
    await repos.connections.recordSync(connection.id, "full");

    const row = await repos.connections.get(connection.id);

    expect(row?.last_sync_at).toBe(T0);
    expect(row?.last_full_refresh_at).toBe(T0 + 600);
  });
});

describe("connections.listActive", () => {
  it("returns connected connections whose provider is still live", async () => {
    const repos = testRepos();
    const live = await seedProvider(repos, { displayName: "A Example Health" });
    const broken = await seedProvider(repos, { displayName: "B Example Health" });
    const deleted = await seedProvider(repos, { displayName: "C Example Health" });

    const liveConnection = await repos.connections.upsertTokens(live, { status: "connected" });
    await repos.connections.upsertTokens(broken, { status: "needs_reauth" });
    await repos.connections.upsertTokens(deleted, { status: "connected" });
    await repos.providers.softDelete(deleted);

    expect(await column(repos.connections.listActive(), "id")).toStrictEqual([liveConnection.id]);
  });

  it("returns null secrets for a connection that does not exist", async () => {
    const repos = testRepos();

    expect(await repos.connections.getSecrets("NOPE")).toBeNull();
    expect(await repos.connections.getForProvider("NOPE")).toBeNull();
  });
});

describe("the connection lease", () => {
  it("is exclusive: exactly one of two contenders wins", async () => {
    // This is the whole reason the lease exists. Epic invalidates a refresh token
    // the moment it is redeemed, so two concurrent refreshes end with a dead
    // connection; only one caller may proceed.
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    const connection = await repos.connections.upsertTokens(providerId, {});

    const results = await Promise.all([
      repos.connections.acquireLease(connection.id, "worker-a", 30_000),
      repos.connections.acquireLease(connection.id, "worker-b", 30_000),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("blocks a second holder until the TTL passes", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const providerId = await seedProvider(repos);
    const connection = await repos.connections.upsertTokens(providerId, {});

    expect(await repos.connections.acquireLease(connection.id, "worker-a", 30_000)).toBe(true);
    expect(await repos.connections.acquireLease(connection.id, "worker-b", 30_000)).toBe(false);

    // Expiry lives in the predicate, so a Worker that died holding the lease
    // blocks nothing past the TTL and no sweeper is needed.
    time.advance(31);

    expect(await repos.connections.acquireLease(connection.id, "worker-b", 30_000)).toBe(true);
    await expect(repos.connections.get(connection.id)).resolves.toMatchObject({
      lease_owner: "worker-b",
    });
  });

  it("rounds a sub-second TTL up rather than to zero", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const providerId = await seedProvider(repos);
    const connection = await repos.connections.upsertTokens(providerId, {});

    await repos.connections.acquireLease(connection.id, "worker-a", 250);

    await expect(repos.connections.get(connection.id)).resolves.toMatchObject({
      lease_expires_at: T0 + 1,
    });
  });

  it("releases only for the owner that holds it", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    const connection = await repos.connections.upsertTokens(providerId, {});
    await repos.connections.acquireLease(connection.id, "worker-a", 30_000);

    expect(await repos.connections.releaseLease(connection.id, "worker-b")).toBe(false);
    expect(await repos.connections.releaseLease(connection.id, "worker-a")).toBe(true);

    const row = await repos.connections.get(connection.id);

    expect(row?.lease_owner).toBeNull();
    expect(row?.lease_expires_at).toBeNull();
    expect(await repos.connections.acquireLease(connection.id, "worker-b", 30_000)).toBe(true);
  });

  it("reports false for a connection that does not exist", async () => {
    const repos = testRepos();

    expect(await repos.connections.acquireLease("NOPE", "worker-a", 30_000)).toBe(false);
  });
});
