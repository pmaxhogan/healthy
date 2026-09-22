import { beforeEach, describe, expect, it } from "vitest";

import { OTHER_DATA_KEY, T0, clock, rawColumn, resetDb, testRepos } from "./helpers.ts";

beforeEach(resetDb);

describe("the google_account row", () => {
  it("exists, disconnected, straight out of the migration", async () => {
    const repos = testRepos();

    const row = await repos.google.get();

    expect(row.id).toBe(1);
    expect(row.status).toBe("disconnected");
    expect(await repos.google.getSecrets()).toStrictEqual({
      email: null,
      accessToken: null,
      refreshToken: null,
    });
  });

  it("round-trips its sealed columns, and the raw ones are not plaintext", async () => {
    const repos = testRepos();

    await repos.google.upsertTokens({
      email: "owner@example.test",
      accessToken: "google-access-token",
      refreshToken: "google-refresh-token",
      accessExpiresAt: T0 + 3600,
      scope: "https://www.googleapis.com/auth/calendar.events.owned",
      status: "connected",
    });

    expect(await repos.google.getSecrets()).toStrictEqual({
      email: "owner@example.test",
      accessToken: "google-access-token",
      refreshToken: "google-refresh-token",
    });

    for (const column of ["email_enc", "access_token_enc", "refresh_token_enc"]) {
      const raw = await rawColumn("google_account", column, "id = 1");

      expect(raw?.startsWith("v1:"), column).toBe(true);
      expect(raw, column).not.toContain("example.test");
      expect(raw, column).not.toContain("google-");
    }
  });

  it("cannot be opened with the wrong key", async () => {
    const repos = testRepos();
    await repos.google.upsertTokens({ accessToken: "a" });

    await expect(testRepos({ dataKey: OTHER_DATA_KEY }).google.getSecrets()).rejects.toMatchObject({
      code: "crypto",
    });
  });

  it("records connected_at once and keeps it across reconnects", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });

    await repos.google.markConnected();
    time.advance(86_400);
    await repos.google.markConnected();

    const row = await repos.google.get();

    expect(row.connected_at).toBe(T0);
    expect(row.updated_at).toBe(T0 + 86_400);
  });

  it("records a re-auth need from when it first broke", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });

    await repos.google.markNeedsReauth();
    time.advance(3600);
    await repos.google.markNeedsReauth();

    const row = await repos.google.get();

    expect(row.status).toBe("needs_reauth");
    expect(row.needs_reauth_since).toBe(T0);
  });

  it("forgets everything on disconnect, without deleting the row", async () => {
    const repos = testRepos();
    await repos.google.upsertTokens({
      email: "owner@example.test",
      accessToken: "a",
      refreshToken: "r",
      status: "connected",
    });

    await repos.google.disconnect();

    const row = await repos.google.get();

    expect(row.id).toBe(1);
    expect(row.status).toBe("disconnected");
    expect(await repos.google.getSecrets()).toStrictEqual({
      email: null,
      accessToken: null,
      refreshToken: null,
    });
  });
});

describe("the google lease", () => {
  it("is exclusive and expires by the clock", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });

    expect(await repos.google.acquireLease("worker-a", 30_000)).toBe(true);
    expect(await repos.google.acquireLease("worker-b", 30_000)).toBe(false);

    time.advance(31);

    expect(await repos.google.acquireLease("worker-b", 30_000)).toBe(true);
  });

  it("picks exactly one winner out of concurrent contenders", async () => {
    const repos = testRepos();

    const results = await Promise.all([
      repos.google.acquireLease("worker-a", 30_000),
      repos.google.acquireLease("worker-b", 30_000),
      repos.google.acquireLease("worker-c", 30_000),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("releases only for its owner", async () => {
    const repos = testRepos();
    await repos.google.acquireLease("worker-a", 30_000);

    expect(await repos.google.releaseLease("worker-b")).toBe(false);
    expect(await repos.google.releaseLease("worker-a")).toBe(true);
    await expect(repos.google.get()).resolves.toMatchObject({ lease_owner: null });
  });
});
