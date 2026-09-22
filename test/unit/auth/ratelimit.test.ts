import { describe, expect, it } from "vitest";

import {
  LOGIN_MAX_ATTEMPTS,
  LOGIN_WINDOW_SECONDS,
  decide,
  forgetLoginAttempts,
  hashClientIp,
  recordLoginAttempt,
  type LoginAttemptStore,
  type LoginAttemptWindow,
} from "../../../worker/auth/ratelimit.ts";

/**
 * An in-memory store with the same semantics as the D1 UPSERT: bump the counter,
 * restarting it when the window has rolled over. The SQL itself is exercised
 * against real D1 in test/integration/auth/login.test.ts; what is under test here
 * is the limiter's arithmetic and its decisions.
 */
function memoryStore(): LoginAttemptStore & { rows: Map<string, LoginAttemptWindow> } {
  const rows = new Map<string, LoginAttemptWindow>();
  return {
    rows,
    bump(ipHash, nowSeconds) {
      const existing = rows.get(ipHash);
      const rolledOver =
        existing === undefined || existing.windowStart <= nowSeconds - LOGIN_WINDOW_SECONDS;
      const next: LoginAttemptWindow = rolledOver
        ? { count: 1, windowStart: nowSeconds }
        : { count: existing.count + 1, windowStart: existing.windowStart };
      rows.set(ipHash, next);
      return Promise.resolve(next);
    },
    clear(ipHash) {
      rows.delete(ipHash);
      return Promise.resolve();
    },
  };
}

function hashOf(ip: string): Promise<string> {
  return hashClientIp(
    new Request("https://healthy.example/auth/login", {
      method: "POST",
      headers: { "cf-connecting-ip": ip },
    }),
  );
}

const IP_HASH = "0".repeat(64);
const T0 = 1_800_000_000;

describe("decide", () => {
  it("allows up to the limit and refuses the one after", () => {
    expect(decide({ count: 1, windowStart: T0 }, T0).allowed).toBe(true);
    expect(decide({ count: LOGIN_MAX_ATTEMPTS, windowStart: T0 }, T0).allowed).toBe(true);
    expect(decide({ count: LOGIN_MAX_ATTEMPTS + 1, windowStart: T0 }, T0).allowed).toBe(false);
  });

  it("reports the seconds left in the window", () => {
    const halfway = T0 + LOGIN_WINDOW_SECONDS / 2;

    expect(decide({ count: 1, windowStart: T0 }, T0).retryAfterSeconds).toBe(LOGIN_WINDOW_SECONDS);
    expect(decide({ count: 1, windowStart: T0 }, halfway).retryAfterSeconds).toBe(
      LOGIN_WINDOW_SECONDS / 2,
    );
  });

  it("never reports a Retry-After of zero", () => {
    // A `Retry-After: 0` invites an immediate retry, which is the opposite of the
    // intent; clamp to a second even at the exact boundary.
    const atBoundary = T0 + LOGIN_WINDOW_SECONDS;

    expect(decide({ count: 99, windowStart: T0 }, atBoundary).retryAfterSeconds).toBe(1);
    expect(decide({ count: 99, windowStart: T0 }, atBoundary + 60).retryAfterSeconds).toBe(1);
  });

  it("is 10 attempts per 15 minutes, as documented", () => {
    expect(LOGIN_MAX_ATTEMPTS).toBe(10);
    expect(LOGIN_WINDOW_SECONDS).toBe(15 * 60);
  });
});

describe("recordLoginAttempt", () => {
  it("counts up and then closes the gate", async () => {
    const store = memoryStore();

    for (let attempt = 1; attempt <= LOGIN_MAX_ATTEMPTS; attempt++) {
      const decision = await recordLoginAttempt(store, IP_HASH, T0);
      expect(decision.count, `attempt ${String(attempt)}`).toBe(attempt);
      expect(decision.allowed, `attempt ${String(attempt)}`).toBe(true);
    }

    const blocked = await recordLoginAttempt(store, IP_HASH, T0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.count).toBe(LOGIN_MAX_ATTEMPTS + 1);
    expect(blocked.retryAfterSeconds).toBe(LOGIN_WINDOW_SECONDS);
  });

  it("keeps the window anchored to its first attempt, so hammering cannot extend it", async () => {
    const store = memoryStore();
    await recordLoginAttempt(store, IP_HASH, T0);

    // Ten minutes and many attempts later, the window still ends 15 minutes
    // after the FIRST attempt. A sliding window would let an attacker keep
    // themselves blocked forever, but it would also never reopen on its own.
    const later = await recordLoginAttempt(store, IP_HASH, T0 + 600);

    expect(store.rows.get(IP_HASH)?.windowStart).toBe(T0);
    expect(later.retryAfterSeconds).toBe(LOGIN_WINDOW_SECONDS - 600);
  });

  it("starts a fresh window once the old one has expired", async () => {
    const store = memoryStore();
    for (let attempt = 0; attempt <= LOGIN_MAX_ATTEMPTS; attempt++) {
      await recordLoginAttempt(store, IP_HASH, T0);
    }
    const spent = await recordLoginAttempt(store, IP_HASH, T0);
    expect(spent.allowed).toBe(false);

    const afterWindow = T0 + LOGIN_WINDOW_SECONDS;
    const reopened = await recordLoginAttempt(store, IP_HASH, afterWindow);

    expect(reopened.allowed).toBe(true);
    expect(reopened.count).toBe(1);
    expect(store.rows.get(IP_HASH)?.windowStart).toBe(afterWindow);
  });

  it("counts each client separately", async () => {
    const store = memoryStore();
    const other = "1".repeat(64);

    for (let attempt = 0; attempt <= LOGIN_MAX_ATTEMPTS; attempt++) {
      await recordLoginAttempt(store, IP_HASH, T0);
    }

    const blocked = await recordLoginAttempt(store, IP_HASH, T0);
    const untouched = await recordLoginAttempt(store, other, T0);

    expect(blocked.allowed).toBe(false);
    expect(untouched.allowed).toBe(true);
  });
});

describe("forgetLoginAttempts", () => {
  it("resets the counter, so ordinary successful use never accumulates", async () => {
    const store = memoryStore();
    for (let attempt = 0; attempt < LOGIN_MAX_ATTEMPTS; attempt++) {
      await recordLoginAttempt(store, IP_HASH, T0);
    }

    await forgetLoginAttempts(store, IP_HASH);
    expect(store.rows.has(IP_HASH)).toBe(false);

    const afterClear = await recordLoginAttempt(store, IP_HASH, T0);
    expect(afterClear.count).toBe(1);
  });
});

describe("hashClientIp", () => {
  it("returns a SHA-256 hex digest, not the address", async () => {
    const request = new Request("https://healthy.example/auth/login", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.7" },
    });

    const hash = await hashClientIp(request);

    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(hash).not.toContain("203");
  });

  it("is stable for one address and different across addresses", async () => {
    const [first, again, other] = await Promise.all([
      hashOf("203.0.113.7"),
      hashOf("203.0.113.7"),
      hashOf("203.0.113.8"),
    ]);

    expect(first).toBe(again);
    expect(first).not.toBe(other);
  });

  it("buckets a request with no client IP under a single key rather than skipping the limit", async () => {
    const request = new Request("https://healthy.example/auth/login", { method: "POST" });

    await expect(hashClientIp(request)).resolves.toMatch(/^[0-9a-f]{64}$/u);
  });
});
