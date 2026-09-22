import { beforeEach, describe, expect, it } from "vitest";

import {
  LOGIN_MAX_ATTEMPTS,
  LOGIN_WINDOW_SECONDS,
} from "../../../worker/db/repos/login-attempts.ts";

import { T0, clock, resetDb, testRepos } from "./helpers.ts";

beforeEach(resetDb);

// A stand-in for the salted hash of a client address. The raw address never
// reaches this table, which is why the tests do not have one.
const IP_HASH = "0".repeat(64);
const OTHER_HASH = "1".repeat(64);

describe("login_attempts.increment", () => {
  it("counts up from one and returns the running count", async () => {
    const repos = testRepos();

    expect(await repos.loginAttempts.increment(IP_HASH)).toBe(1);
    expect(await repos.loginAttempts.increment(IP_HASH)).toBe(2);
    expect(await repos.loginAttempts.increment(IP_HASH)).toBe(3);
    await expect(repos.loginAttempts.get(IP_HASH)).resolves.toMatchObject({ window_start: T0 });
  });

  it("counts each client separately", async () => {
    const repos = testRepos();

    await repos.loginAttempts.increment(IP_HASH);
    await repos.loginAttempts.increment(IP_HASH);

    expect(await repos.loginAttempts.increment(OTHER_HASH)).toBe(1);
    expect(await repos.loginAttempts.list()).toHaveLength(2);
  });

  it("starts a new window once the old one has rolled", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });

    await repos.loginAttempts.increment(IP_HASH);
    await repos.loginAttempts.increment(IP_HASH);
    time.advance(LOGIN_WINDOW_SECONDS + 1);

    expect(await repos.loginAttempts.increment(IP_HASH)).toBe(1);
    await expect(repos.loginAttempts.get(IP_HASH)).resolves.toMatchObject({
      window_start: T0 + LOGIN_WINDOW_SECONDS + 1,
    });
  });

  it("keeps counting inside the window right up to its edge", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });

    await repos.loginAttempts.increment(IP_HASH);
    time.advance(LOGIN_WINDOW_SECONDS - 1);

    expect(await repos.loginAttempts.increment(IP_HASH)).toBe(2);
  });

  it("does not lose a count to a concurrent attempt", async () => {
    // One statement, not read-then-write, so two simultaneous guesses both count.
    const repos = testRepos();

    const counts = await Promise.all([
      repos.loginAttempts.increment(IP_HASH),
      repos.loginAttempts.increment(IP_HASH),
      repos.loginAttempts.increment(IP_HASH),
    ]);

    // Order is whatever the database applied them in; the counts are the point.
    expect(new Set(counts)).toStrictEqual(new Set([1, 2, 3]));
  });
});

describe("login_attempts.isBlocked", () => {
  it("is false until the limit is reached and true afterwards", async () => {
    const repos = testRepos();

    for (let attempt = 1; attempt < LOGIN_MAX_ATTEMPTS; attempt++) {
      await repos.loginAttempts.increment(IP_HASH);
      expect(await repos.loginAttempts.isBlocked(IP_HASH), String(attempt)).toBe(false);
    }
    await repos.loginAttempts.increment(IP_HASH);

    expect(await repos.loginAttempts.isBlocked(IP_HASH)).toBe(true);
  });

  it("is false for a client it has never seen", async () => {
    const repos = testRepos();

    expect(await repos.loginAttempts.isBlocked(IP_HASH)).toBe(false);
  });

  it("stops blocking once the window rolls, whatever the stored count says", async () => {
    // The lockout is something you can wait out, which is the point of a window.
    const time = clock();
    const repos = testRepos({ now: time.now });
    for (let attempt = 0; attempt < LOGIN_MAX_ATTEMPTS; attempt++) {
      await repos.loginAttempts.increment(IP_HASH);
    }

    expect(await repos.loginAttempts.isBlocked(IP_HASH)).toBe(true);

    time.advance(LOGIN_WINDOW_SECONDS);

    expect(await repos.loginAttempts.isBlocked(IP_HASH)).toBe(false);
    await expect(repos.loginAttempts.get(IP_HASH)).resolves.toMatchObject({
      count: LOGIN_MAX_ATTEMPTS,
    });
  });

  it("honours a tighter limit and a shorter window when given one", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });

    await repos.loginAttempts.increment(IP_HASH, { windowSeconds: 60 });
    await repos.loginAttempts.increment(IP_HASH, { windowSeconds: 60 });

    expect(await repos.loginAttempts.isBlocked(IP_HASH, { limit: 2, windowSeconds: 60 })).toBe(
      true,
    );

    time.advance(61);

    expect(await repos.loginAttempts.isBlocked(IP_HASH, { limit: 2, windowSeconds: 60 })).toBe(
      false,
    );
  });
});

describe("login_attempts.reset and purgeExpired", () => {
  it("clears one client on a successful login", async () => {
    const repos = testRepos();
    await repos.loginAttempts.increment(IP_HASH);
    await repos.loginAttempts.increment(OTHER_HASH);

    await repos.loginAttempts.reset(IP_HASH);

    expect(await repos.loginAttempts.get(IP_HASH)).toBeNull();
    expect(await repos.loginAttempts.get(OTHER_HASH)).not.toBeNull();
  });

  it("drops only the rows whose window has rolled", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });

    await repos.loginAttempts.increment(IP_HASH);
    time.advance(LOGIN_WINDOW_SECONDS + 1);
    await repos.loginAttempts.increment(OTHER_HASH);

    expect(await repos.loginAttempts.purgeExpired()).toBe(1);
    expect(await repos.loginAttempts.list()).toHaveLength(1);
  });
});
