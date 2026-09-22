import { beforeEach, describe, expect, it } from "vitest";

import { clock, rawColumn, resetDb, seedProvider, testRepos } from "./helpers.ts";

beforeEach(resetDb);

describe("oauth_states.put", () => {
  it("returns an opaque state and seals the PKCE verifier", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);

    const state = await repos.oauthStates.put({
      kind: "epic",
      providerId,
      codeVerifier: "an-obviously-distinctive-verifier",
      redirectAfter: "/providers",
      ttlMs: 600_000,
    });

    expect(state).toMatch(/^[0-9a-f]{64}$/u);

    const raw = await rawColumn("oauth_states", "code_verifier_enc", "state = ?", state);

    expect(raw?.startsWith("v1:")).toBe(true);
    expect(raw).not.toContain("distinctive");
  });

  it("gives every call a different state", async () => {
    const repos = testRepos();

    const states = await Promise.all(
      Array.from({ length: 5 }, () =>
        repos.oauthStates.put({ kind: "google", codeVerifier: "v", ttlMs: 600_000 }),
      ),
    );

    expect(new Set(states).size).toBe(5);
  });

  it("is rejected by the schema when kind and provider disagree", async () => {
    // A CHECK constraint, not a code path: an Epic authorization is always
    // against one provider and a Google one never is.
    const repos = testRepos();
    const providerId = await seedProvider(repos);

    await expect(
      repos.oauthStates.put({ kind: "epic", codeVerifier: "v", ttlMs: 600_000 }),
    ).rejects.toThrow();
    await expect(
      repos.oauthStates.put({ kind: "google", providerId, codeVerifier: "v", ttlMs: 600_000 }),
    ).rejects.toThrow();
  });
});

describe("oauth_states.consume", () => {
  it("returns the state's contents once and only once", async () => {
    // Single-use is the point: a replayed callback URL must not complete twice.
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    const state = await repos.oauthStates.put({
      kind: "epic",
      providerId,
      codeVerifier: "verifier-value",
      redirectAfter: "/providers",
      ttlMs: 600_000,
    });

    expect(await repos.oauthStates.consume(state)).toStrictEqual({
      state,
      kind: "epic",
      providerId,
      codeVerifier: "verifier-value",
      redirectAfter: "/providers",
    });
    expect(await repos.oauthStates.consume(state)).toBeNull();
    expect(await repos.oauthStates.count()).toBe(0);
  });

  it("hands the row to exactly one of two concurrent redemptions", async () => {
    const repos = testRepos();
    const state = await repos.oauthStates.put({
      kind: "google",
      codeVerifier: "v",
      ttlMs: 600_000,
    });

    const results = await Promise.all([
      repos.oauthStates.consume(state),
      repos.oauthStates.consume(state),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
  });

  it("returns null for a state it has never seen", async () => {
    const repos = testRepos();

    expect(await repos.oauthStates.consume("0".repeat(64))).toBeNull();
  });

  it("refuses an expired state, and removes it as well", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const state = await repos.oauthStates.put({
      kind: "google",
      codeVerifier: "v",
      ttlMs: 600_000,
    });

    time.advance(601);

    expect(await repos.oauthStates.consume(state)).toBeNull();
    expect(await repos.oauthStates.count()).toBe(0);
  });
});

describe("oauth_states.purgeExpired", () => {
  it("drops only the states past their expiry", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });

    await repos.oauthStates.put({ kind: "google", codeVerifier: "v", ttlMs: 60_000 });
    time.advance(120);
    const fresh = await repos.oauthStates.put({ kind: "google", codeVerifier: "v", ttlMs: 60_000 });

    expect(await repos.oauthStates.purgeExpired()).toBe(1);
    expect(await repos.oauthStates.count()).toBe(1);
    await expect(repos.oauthStates.consume(fresh)).resolves.toMatchObject({ codeVerifier: "v" });
  });

  it("cascades when its provider goes away", async () => {
    // ON DELETE CASCADE on provider_id: a hard-deleted provider cannot leave an
    // in-flight authorization behind that would complete against nothing.
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    await repos.oauthStates.put({ kind: "epic", providerId, codeVerifier: "v", ttlMs: 600_000 });

    await repos.ctx.db.prepare("DELETE FROM providers WHERE id = ?").bind(providerId).run();

    expect(await repos.oauthStates.count()).toBe(0);
  });
});
