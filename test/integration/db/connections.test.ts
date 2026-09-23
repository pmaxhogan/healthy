import { beforeEach, describe, expect, it } from "vitest";

import {
  OTHER_DATA_KEY,
  T0,
  clock,
  column,
  rawColumn,
  resetDb,
  seedHealthSystem,
  testRepos,
} from "./helpers.ts";

beforeEach(resetDb);

describe("connections.upsertTokens", () => {
  it("creates the row on first write and seals every secret column", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);

    const connection = await repos.connections.upsertTokens(healthSystemId, {
      patientFhirId: "patient-identifier-one",
      accessToken: "access-token-one",
      refreshToken: "refresh-token-one",
      accessExpiresAt: T0 + 3600,
      scope: "patient/Encounter.read",
      status: "connected",
    });

    expect(connection.health_system_id).toBe(healthSystemId);
    expect(connection.status).toBe("connected");
    expect(connection.access_expires_at).toBe(T0 + 3600);
    expect(await repos.connections.getSecrets(connection.id)).toStrictEqual({
      patientFhirId: "patient-identifier-one",
      accessToken: "access-token-one",
      refreshToken: "refresh-token-one",
    });

    for (const column of ["patient_fhir_id_enc", "access_token_enc", "refresh_token_enc"]) {
      const raw = await rawColumn("connections", column, "id = ?", connection.id);

      expect(raw ?? "", column).toMatch(/^v[12]:/u);
      expect(raw, column).not.toContain("token-one");
      expect(raw, column).not.toContain("patient-identifier");
    }
  });

  it("reuses the same row, and the same id, on a second write", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);

    const first = await repos.connections.upsertTokens(healthSystemId, { accessToken: "a" });
    const second = await repos.connections.upsertTokens(healthSystemId, { accessToken: "b" });

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
    const healthSystemId = await seedHealthSystem(repos);

    const connection = await repos.connections.upsertTokens(healthSystemId, {
      accessToken: "access-1",
      refreshToken: "refresh-1",
    });
    await repos.connections.upsertTokens(healthSystemId, { accessToken: "access-2" });

    expect(await repos.connections.getSecrets(connection.id)).toStrictEqual({
      patientFhirId: null,
      accessToken: "access-2",
      refreshToken: "refresh-1",
    });
  });

  it("cannot be opened with the wrong key", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);
    const connection = await repos.connections.upsertTokens(healthSystemId, { accessToken: "a" });

    await expect(
      testRepos({ dataKey: OTHER_DATA_KEY }).connections.getSecrets(connection.id),
    ).rejects.toMatchObject({ code: "crypto" });
  });

  it("cannot have a token moved between its own columns", async () => {
    // The AAD includes the column, not just the row, so an access token pasted
    // into the refresh column does not open.
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);
    const connection = await repos.connections.upsertTokens(healthSystemId, { accessToken: "a" });
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
    const healthSystemId = await seedHealthSystem(repos);
    const connection = await repos.connections.upsertTokens(healthSystemId, {
      status: "connected",
    });

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
    const healthSystemId = await seedHealthSystem(repos);
    const connection = await repos.connections.upsertTokens(healthSystemId, {});
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
    const healthSystemId = await seedHealthSystem(repos);
    const connection = await repos.connections.upsertTokens(healthSystemId, { accessToken: "a" });

    expect(await repos.connections.markError(connection.id, "upstream_unavailable")).toBe(true);

    await expect(repos.connections.get(connection.id)).resolves.toMatchObject({ status: "error" });
    await expect(repos.connections.getSecrets(connection.id)).resolves.toMatchObject({
      accessToken: "a",
    });
  });

  it("forgets the tokens on disconnect but keeps the row", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);
    const connection = await repos.connections.upsertTokens(healthSystemId, {
      accessToken: "a",
      refreshToken: "r",
      patientFhirId: "p",
    });

    expect(await repos.connections.disconnect(connection.id)).toBe(true);

    expect(await repos.connections.getSecrets(connection.id)).toStrictEqual({
      // The patient id goes with the tokens. It is the one column here that names
      // a person, and the privacy page says disconnecting revokes what is stored;
      // rediscovering it on re-authorisation costs one request.
      patientFhirId: null,
      accessToken: null,
      refreshToken: null,
    });
    await expect(repos.connections.get(connection.id)).resolves.toMatchObject({
      status: "disconnected",
      scope: null,
      lease_owner: null,
      lease_expires_at: null,
    });
  });

  it("stamps the right clock per kind of sync", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const healthSystemId = await seedHealthSystem(repos);
    const connection = await repos.connections.upsertTokens(healthSystemId, {});

    await repos.connections.recordSync(connection.id, "calendar");
    time.advance(600);
    await repos.connections.recordSync(connection.id, "full");

    const row = await repos.connections.get(connection.id);

    expect(row?.last_sync_at).toBe(T0);
    expect(row?.last_full_refresh_at).toBe(T0 + 600);
  });
});

describe("connections.listActive", () => {
  it("returns connected connections whose health system is still live", async () => {
    const repos = testRepos();
    const live = await seedHealthSystem(repos, { displayName: "A Example Health" });
    const broken = await seedHealthSystem(repos, { displayName: "B Example Health" });
    const deleted = await seedHealthSystem(repos, { displayName: "C Example Health" });

    const liveConnection = await repos.connections.upsertTokens(live, { status: "connected" });
    await repos.connections.upsertTokens(broken, { status: "needs_reauth" });
    await repos.connections.upsertTokens(deleted, { status: "connected" });
    await repos.healthSystems.softDelete(deleted);

    expect(await column(repos.connections.listActive(), "id")).toStrictEqual([liveConnection.id]);
  });

  it("returns null secrets for a connection that does not exist", async () => {
    const repos = testRepos();

    expect(await repos.connections.getSecrets("NOPE")).toBeNull();
    expect(await repos.connections.getForHealthSystem("NOPE")).toBeNull();
  });
});

describe("the connection lease", () => {
  it("is exclusive: exactly one of two contenders wins", async () => {
    // This is the whole reason the lease exists. Epic invalidates a refresh token
    // the moment it is redeemed, so two concurrent refreshes end with a dead
    // connection; only one caller may proceed.
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);
    const connection = await repos.connections.upsertTokens(healthSystemId, {});

    const results = await Promise.all([
      repos.connections.acquireLease(connection.id, "worker-a", 30_000),
      repos.connections.acquireLease(connection.id, "worker-b", 30_000),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("blocks a second holder until the TTL passes", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const healthSystemId = await seedHealthSystem(repos);
    const connection = await repos.connections.upsertTokens(healthSystemId, {});

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
    const healthSystemId = await seedHealthSystem(repos);
    const connection = await repos.connections.upsertTokens(healthSystemId, {});

    await repos.connections.acquireLease(connection.id, "worker-a", 250);

    await expect(repos.connections.get(connection.id)).resolves.toMatchObject({
      lease_expires_at: T0 + 1,
    });
  });

  it("releases only for the owner that holds it", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);
    const connection = await repos.connections.upsertTokens(healthSystemId, {});
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

describe("a token write under the lease", () => {
  it("refuses the loser whose lease expired while its refresh was in flight", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const healthSystemId = await seedHealthSystem(repos);
    const connection = await repos.connections.upsertTokens(healthSystemId, {
      accessToken: "access-0",
      refreshToken: "refresh-0",
    });

    // A takes the lease and posts to a token endpoint that then hangs.
    expect(await repos.connections.acquireLease(connection.id, "worker-a", 30_000)).toBe(true);
    // The hang outlasts the TTL, so B takes the lease, refreshes, and stores the
    // rotated refresh token. Epic's are single-use: refresh-0 is now dead.
    time.advance(31);
    expect(await repos.connections.acquireLease(connection.id, "worker-b", 30_000)).toBe(true);
    expect(
      await repos.connections.upsertTokensLeased(healthSystemId, "worker-b", {
        accessToken: "access-b",
        refreshToken: "refresh-b",
      }),
    ).not.toBeNull();
    const afterWinner = await repos.connections.get(connection.id);

    // A wakes up last. Its write must not land: refresh-b is the only token the
    // organisation will accept, and overwriting it costs the owner a re-auth.
    expect(
      await repos.connections.upsertTokensLeased(healthSystemId, "worker-a", {
        accessToken: "access-a",
        refreshToken: "refresh-a",
      }),
    ).toBeNull();

    await expect(repos.connections.getSecrets(connection.id)).resolves.toMatchObject({
      accessToken: "access-b",
      refreshToken: "refresh-b",
    });
    // Nothing at all moved, so the keepalive still sees B's refresh as the last one.
    await expect(repos.connections.get(connection.id)).resolves.toMatchObject({
      last_refresh_at: afterWinner?.last_refresh_at,
      updated_at: afterWinner?.updated_at,
    });
  });

  it("refuses an unleased write while a refresh holds the lease, and allows it after", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const healthSystemId = await seedHealthSystem(repos);
    const connection = await repos.connections.upsertTokens(healthSystemId, { refreshToken: "r0" });
    await repos.connections.acquireLease(connection.id, "worker-a", 30_000);

    // The authorization callback holds no lease, so all it can do is refuse.
    await expect(
      repos.connections.upsertTokens(healthSystemId, { refreshToken: "from-callback" }),
    ).rejects.toMatchObject({ code: "conflict" });

    // An expired lease blocks nothing: a Worker that died holding one leaves
    // `lease_owner` set, and reconnecting must not be hostage to it.
    time.advance(31);
    await expect(
      repos.connections.upsertTokens(healthSystemId, { refreshToken: "from-callback" }),
    ).resolves.toMatchObject({ id: connection.id });
    await expect(repos.connections.getSecrets(connection.id)).resolves.toMatchObject({
      refreshToken: "from-callback",
    });
  });
});
