import { describe, expect, it, vi } from "vitest";

import {
  PermanentError,
  TransientError,
  classifyStatus,
  classifyThrown,
  computeDelayMs,
  parseRetryAfter,
  retriedFetch,
} from "../../../worker/lib/retry.ts";

import type { ErrorClass, RetryOpts, RetryOutcome } from "../../../worker/lib/retry.ts";

const URL = "https://fhir.example.test/R4/Encounter";

/** A fetch that answers from a script, recording the sleeps it caused. */
function harness(
  script: (Response | Error)[],
  overrides: RetryOpts = {},
): { opts: RetryOpts; sleeps: number[]; calls: number } {
  const sleeps: number[] = [];
  const state = { calls: 0 };
  let clock = 1_000_000;
  const opts: RetryOpts = {
    // No jitter: 0.5 is the midpoint, so the delay is exactly the exponential.
    random: () => 0.5,
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    fetchImpl: () => {
      const next = script[state.calls];
      state.calls += 1;
      if (next === undefined) {
        throw new Error(`script exhausted after ${String(state.calls)} calls`);
      }
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    ...overrides,
  };
  return {
    opts,
    sleeps,
    get calls() {
      return state.calls;
    },
  };
}

/** Await a promise that must reject, and hand back what it rejected with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

const ok = (): Response => new Response("{}", { status: 200 });
const status = (code: number, headers: Record<string, string> = {}): Response =>
  new Response("boom", { status: code, headers });

describe("classifyStatus", () => {
  it("splits auth, transient and permanent the way the retry loop needs", () => {
    const cases: [number, ErrorClass][] = [
      [200, "permanent"], // never consulted for a 2xx; documented here anyway
      [401, "auth"],
      [403, "auth"],
      [400, "permanent"],
      [404, "permanent"],
      [409, "permanent"],
      [408, "transient"],
      [425, "transient"],
      [429, "transient"],
      [500, "transient"],
      [503, "transient"],
      [599, "transient"],
      [600, "permanent"],
    ];

    for (const [code, expected] of cases) {
      expect(classifyStatus(code), String(code)).toBe(expected);
    }
  });
});

describe("classifyThrown", () => {
  it("treats network-shaped failures as transient and everything else as permanent", () => {
    expect(classifyThrown(new Error("fetch failed"))).toBe("transient");
    expect(classifyThrown(new Error("ECONNRESET"))).toBe("transient");
    expect(classifyThrown(new Error("per-attempt timeout"))).toBe("transient");
    expect(classifyThrown(new TypeError("Invalid URL"))).toBe("permanent");
    expect(classifyThrown("nonsense")).toBe("permanent");
  });
});

describe("computeDelayMs", () => {
  const base = { baseDelayMs: 200, maxDelayMs: 5000, random: () => 0.5 };

  it("doubles per retry and caps at maxDelayMs", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((retry) => computeDelayMs(retry, base))).toStrictEqual([
      200, 400, 800, 1600, 3200, 5000, 5000,
    ]);
  });

  it("jitters by +/-25%", () => {
    expect(computeDelayMs(0, { ...base, random: () => 0 })).toBe(150);
    expect(computeDelayMs(0, { ...base, random: () => 1 })).toBe(250);
  });

  it("raises the delay to Retry-After when that is longer, still under the cap", () => {
    expect(computeDelayMs(0, base, 3000)).toBe(3000);
    expect(computeDelayMs(0, base, 60_000)).toBe(5000);
    // A shorter Retry-After never shortens the backoff.
    expect(computeDelayMs(2, base, 100)).toBe(800);
  });
});

describe("parseRetryAfter", () => {
  it("reads a delta-seconds header", () => {
    expect(parseRetryAfter("120")).toBe(120_000);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("reads an HTTP-date header relative to the injected clock", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");

    expect(parseRetryAfter("Thu, 01 Jan 2026 00:02:00 GMT", () => now)).toBe(120_000);
    // A date in the past is zero, not negative.
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT", () => now + 5000)).toBe(0);
  });

  it("returns null for a missing or unparseable header", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });
});

describe("retriedFetch", () => {
  it("returns the first success without sleeping", async () => {
    const h = harness([ok()]);

    const outcome: RetryOutcome<Response> = await retriedFetch(URL, {}, h.opts);

    expect(outcome.value.status).toBe(200);
    expect(outcome.retries).toBe(0);
    expect(h.sleeps).toStrictEqual([]);
  });

  it("retries a 5xx with exponential backoff and returns the eventual success", async () => {
    const h = harness([status(500), status(503), ok()]);

    const outcome = await retriedFetch(URL, {}, h.opts);

    expect(outcome.retries).toBe(2);
    expect(h.sleeps).toStrictEqual([200, 400]);
  });

  it("retries a network failure too", async () => {
    const h = harness([new Error("fetch failed"), ok()]);

    await expect(retriedFetch(URL, {}, h.opts)).resolves.toMatchObject({ retries: 1 });
    expect(h.sleeps).toStrictEqual([200]);
  });

  it("returns a 401 to the caller instead of retrying it", async () => {
    // The caller refreshes the token and retries once; retrying here would burn
    // the budget on a request that cannot succeed.
    const h = harness([status(401)]);

    const outcome = await retriedFetch(URL, {}, h.opts);

    expect(outcome.value.status).toBe(401);
    expect(h.calls).toBe(1);
    expect(h.sleeps).toStrictEqual([]);
  });

  it("throws a PermanentError on a 4xx that is not auth, without retrying", async () => {
    const h = harness([status(404)]);

    await expect(retriedFetch(URL, {}, h.opts)).rejects.toMatchObject({
      name: "PermanentError",
      status: 404,
    });
    expect(h.calls).toBe(1);
    expect(h.sleeps).toStrictEqual([]);
  });

  it("throws a PermanentError on a thrown error that is not network-shaped", async () => {
    const h = harness([new TypeError("Invalid URL")]);

    await expect(retriedFetch(URL, {}, h.opts)).rejects.toThrow(PermanentError);
    expect(h.calls).toBe(1);
  });

  it("honours Retry-After on a 429 and reports it on the final error", async () => {
    const h = harness([
      status(429, { "retry-after": "2" }),
      status(429, { "retry-after": "2" }),
      status(429, { "retry-after": "2" }),
    ]);

    const error = await rejection(retriedFetch(URL, {}, { ...h.opts, maxAttempts: 3 }));

    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ attempts: 3, lastStatus: 429, retryAfterMs: 2000 });
    // 2 s beats the 200 ms and 400 ms exponential delays.
    expect(h.sleeps).toStrictEqual([2000, 2000]);
  });

  it("stops on the wall-clock budget rather than sleeping past it", async () => {
    // The budget is the thing that keeps one slow org from eating the whole
    // scheduled run, so it has to win over the remaining attempts.
    const h = harness([status(503, { "retry-after": "3600" }), ok()]);

    const error = await rejection(retriedFetch(URL, {}, { ...h.opts, maxTotalMs: 1000 }));

    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ lastStatus: 503, retryAfterMs: 3_600_000 });
    expect((error as TransientError).message).toContain("budget exhausted");
    expect(h.sleeps).toStrictEqual([]);
    expect(h.calls).toBe(1);
  });

  it("gives up after maxAttempts and names the last failure", async () => {
    const h = harness([status(500), status(500)]);

    await expect(retriedFetch(URL, {}, { ...h.opts, maxAttempts: 2 })).rejects.toThrow(
      /HTTP 500 after 2 attempts/,
    );
    expect(h.calls).toBe(2);
  });

  it("remembers a Retry-After seen on an earlier attempt", async () => {
    const h = harness([status(429, { "retry-after": "5" }), status(500), status(500)]);

    const error = await rejection(retriedFetch(URL, {}, { ...h.opts, maxAttempts: 3 }));

    // The last response carried no header, but the caller still needs to know
    // the upstream asked for 5 s so it can back the whole run off.
    expect(error).toMatchObject({ retryAfterMs: 5000, lastStatus: 500 });
  });

  it("aborts an attempt that outruns perAttemptTimeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const seen: (AbortSignal | null | undefined)[] = [];
      const pending = retriedFetch(
        URL,
        {},
        {
          maxAttempts: 1,
          perAttemptTimeoutMs: 50,
          fetchImpl: (_input, init) =>
            new Promise((_resolve, reject) => {
              seen.push(init?.signal);
              init?.signal?.addEventListener("abort", () => {
                reject(new Error("per-attempt timeout"));
              });
            }),
        },
      );
      const settled = rejection(pending);

      await vi.advanceTimersByTimeAsync(60);

      expect(await settled).toBeInstanceOf(TransientError);
      expect(seen[0]).toBeInstanceOf(AbortSignal);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes the caller's init through, signal included", async () => {
    const seen: RequestInit[] = [];
    const outcome = await retriedFetch(
      URL,
      { method: "POST", headers: { accept: "application/fhir+json" } },
      {
        fetchImpl: (_input, init) => {
          if (init) seen.push(init);
          return Promise.resolve(ok());
        },
      },
    );

    expect(outcome.value.status).toBe(200);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.headers).toStrictEqual({ accept: "application/fhir+json" });
  });
});
