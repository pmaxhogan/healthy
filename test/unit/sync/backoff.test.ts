// The backoff is two small functions and one judgement call: which errors mean
// "you are going too fast" and which mean "this connection is broken". Getting
// the second one wrong would stop the whole sync for one provider's bad token.

import { describe, expect, it } from "vitest";

import { AppError } from "../../../worker/lib/errors.ts";
import { MIN_BACKOFF_MS, backoffUntilSeconds, rateLimitOf } from "../../../worker/sync/backoff.ts";

const NOW = 1_790_000_000;

describe("rateLimitOf", () => {
  it("recognises an upstream_unavailable carrying a Retry-After", () => {
    // What `retriedFetch` produces once it has exhausted its own retries on a 429.
    const error = new AppError(
      "upstream_unavailable",
      "too fast",
      { status: 429 },
      {
        retryAfterMs: 60_000,
      },
    );

    expect(rateLimitOf(error)).toStrictEqual({ retryAfterMs: 60_000, status: 429 });
  });

  it("recognises a 429 that carried no Retry-After", () => {
    const error = new AppError("upstream_error", "too fast", { status: 429 });

    expect(rateLimitOf(error)).toStrictEqual({ retryAfterMs: undefined, status: 429 });
  });

  it("recognises the app's own rate_limited code", () => {
    expect(rateLimitOf(new AppError("rate_limited"))).toStrictEqual({
      retryAfterMs: undefined,
      status: null,
    });
  });

  it("recognises Google's quota exhaustion, which arrives as a 403", () => {
    // Google uses 403 for most quota, and `calendar.ts` turns that into an
    // upstream_unavailable with the Retry-After attached.
    const error = new AppError(
      "upstream_unavailable",
      "quota",
      { status: 403 },
      {
        retryAfterMs: 30_000,
      },
    );

    expect(rateLimitOf(error)).toStrictEqual({ retryAfterMs: 30_000, status: 403 });
  });

  it("does not mistake a broken connection for a rate limit", () => {
    // These are per-connection problems. Backing every provider off for one of
    // them would cost the owner every other organisation's appointments.
    expect(rateLimitOf(new AppError("needs_reauth"))).toBeNull();
    expect(rateLimitOf(new AppError("upstream_auth", "forbidden", { status: 403 }))).toBeNull();
    expect(rateLimitOf(new AppError("upstream_error", "bad", { status: 400 }))).toBeNull();
  });

  it("does not mistake a plain 5xx retry exhaustion for a rate limit", () => {
    expect(
      rateLimitOf(new AppError("upstream_unavailable", "gateway", { status: 502 })),
    ).toBeNull();
  });

  it("ignores anything that is not an AppError", () => {
    expect(rateLimitOf(new Error("429"))).toBeNull();
    expect(rateLimitOf(null)).toBeNull();
    expect(rateLimitOf("429")).toBeNull();
  });
});

describe("backoffUntilSeconds", () => {
  it("never backs off for less than two hours", () => {
    expect(backoffUntilSeconds(NOW, 60_000)).toBe(NOW + MIN_BACKOFF_MS / 1000);
    expect(backoffUntilSeconds(NOW)).toBe(NOW + MIN_BACKOFF_MS / 1000);
    expect(backoffUntilSeconds(NOW, 0)).toBe(NOW + MIN_BACKOFF_MS / 1000);
  });

  it("honours a Retry-After longer than two hours", () => {
    const aDay = 24 * 60 * 60 * 1000;

    expect(backoffUntilSeconds(NOW, aDay)).toBe(NOW + 86_400);
  });

  it("rounds up, so the next run cannot start inside the window", () => {
    const justOver = MIN_BACKOFF_MS + 1;

    expect(backoffUntilSeconds(NOW, justOver)).toBe(NOW + MIN_BACKOFF_MS / 1000 + 1);
  });
});
