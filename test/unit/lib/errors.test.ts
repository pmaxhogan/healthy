import { describe, expect, it } from "vitest";

import { AppError, isAppError, toAppError } from "../../../worker/lib/errors.ts";

import type { AppErrorBody, ErrorCode } from "../../../worker/lib/errors.ts";

describe("AppError", () => {
  it("maps every code to the HTTP status the API should answer with", () => {
    const expected: [ErrorCode, number][] = [
      ["bad_request", 400],
      ["unauthorized", 401],
      ["forbidden", 403],
      ["not_found", 404],
      ["conflict", 409],
      ["rate_limited", 429],
      ["upstream_auth", 502],
      ["upstream_unavailable", 503],
      ["upstream_error", 502],
      ["needs_reauth", 409],
      ["not_connected", 409],
      ["policy_denied", 403],
      ["crypto", 500],
      ["internal", 500],
      ["portal_login_failed", 502],
      ["portal_handoff_failed", 502],
      ["portal_2fa_required", 409],
      ["portal_2fa_rejected", 409],
      ["portal_locked", 409],
      ["portal_captcha_required", 409],
      ["portal_bot_blocked", 503],
      ["portal_session_expired", 409],
      ["portal_parse_failed", 502],
      ["portal_unreachable", 503],
    ];

    for (const [code, status] of expected) {
      expect(new AppError(code).status, code).toBe(status);
    }
  });

  it("falls back to the code as the message", () => {
    expect(new AppError("policy_denied").message).toBe("policy_denied");
  });

  it("carries a cause and a Retry-After without putting either in the body", () => {
    const cause = new Error("upstream said so");
    const error = new AppError("rate_limited", "slow down", undefined, {
      cause,
      retryAfterMs: 7_200_000,
    });

    expect(error.cause).toBe(cause);
    expect(error.retryAfterMs).toBe(7_200_000);
    expect(error.toBody()).toStrictEqual<AppErrorBody>({
      error: "rate_limited",
      message: "slow down",
    });
  });

  it("includes details in the body only when there are some", () => {
    expect(new AppError("bad_request", "nope", { field: "timezone" }).toBody()).toStrictEqual({
      error: "bad_request",
      message: "nope",
      details: { field: "timezone" },
    });
  });

  it("is a real Error subclass, so instanceof and name both work", () => {
    const error = new AppError("internal");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AppError");
    expect(error.stack).toBeTruthy();
  });
});

describe("isAppError", () => {
  it("distinguishes an AppError from anything else", () => {
    expect(isAppError(new AppError("conflict"))).toBe(true);
    expect(isAppError(new Error("conflict"))).toBe(false);
    expect(isAppError("conflict")).toBe(false);
    expect(isAppError(null)).toBe(false);
  });
});

describe("toAppError", () => {
  it("passes an AppError through untouched", () => {
    const original = new AppError("needs_reauth");

    expect(toAppError(original)).toBe(original);
  });

  it("wraps a plain Error, keeping the message and the cause", () => {
    const original = new Error("D1_ERROR: constraint failed");
    const wrapped = toAppError(original);

    expect(wrapped.code).toBe("internal");
    expect(wrapped.message).toBe("D1_ERROR: constraint failed");
    expect(wrapped.cause).toBe(original);
  });

  it("wraps a thrown non-Error and honours the fallback code", () => {
    const wrapped = toAppError("just a string", "upstream_error");

    expect(wrapped.code).toBe("upstream_error");
    expect(wrapped.message).toBe("just a string");
  });
});
