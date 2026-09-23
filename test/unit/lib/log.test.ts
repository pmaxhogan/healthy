import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../../worker/lib/errors.ts";
import {
  errorFields,
  logLine,
  makeLogger,
  noopLogger,
  redactFields,
  redactString,
  redactValue,
} from "../../../worker/lib/log.ts";

import type { LogLevel, Logger, LoggerOptions } from "../../../worker/lib/log.ts";

/** A logger whose lines the test can read back as parsed objects. */
function collector(
  base: Record<string, unknown> = {},
  options: Omit<LoggerOptions, "sink"> = {},
): { log: Logger; lines: Record<string, unknown>[]; levels: LogLevel[] } {
  const lines: Record<string, unknown>[] = [];
  const levels: LogLevel[] = [];
  const log = makeLogger(base, {
    ...options,
    sink: (level, line) => {
      levels.push(level);
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  return { log, lines, levels };
}

describe("redactString", () => {
  it("strips the credential out of an Authorization value", () => {
    expect(redactString("Bearer eyJhbGciOi.payload.sig")).toBe("Bearer [redacted]");
    expect(redactString("Basic dXNlcjpwYXNz")).toBe("Basic [redacted]");
    expect(redactString("sent Bearer abc123 upstream")).toBe("sent Bearer [redacted] upstream");
  });

  it("replaces anything address-shaped", () => {
    expect(redactString("owner@example.test")).toBe("[email]");
    expect(redactString("login failed for owner@example.test twice")).toBe(
      "login failed for [email] twice",
    );
  });

  it("collapses a long opaque token to its length", () => {
    const token = "a".repeat(64);

    expect(redactString(token)).toBe("[opaque:64]");
    // Short ids stay readable: an id is how a log line is joined to a row.
    expect(redactString("01JRQ8ZVME000000000000000Z")).toBe("01JRQ8ZVME000000000000000Z");
  });

  it("collapses a JWT, whose dots used to make it invisible to the shape rule", () => {
    // Epic's access and id tokens are JWTs: three base64url segments, dotted.
    const jwt = [
      "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9",
      "eyJzdWIiOiJlM0x2UUZqeEtnOEFCQ0RFRkdIIn0",
      "c2lnbmF0dXJlLXRoYXQtaXMtbG9uZy1lbm91Z2gtdG8tbG9va19yZWFs",
    ].join(".");

    expect(redactString(jwt)).toBe(`[opaque:${String(jwt.length)}]`);
    // ...and embedded in a sentence, which is how it reaches `errorMessage`.
    expect(redactString(`token endpoint rejected ${jwt} twice`)).toBe(
      `token endpoint rejected [opaque:${String(jwt.length)}] twice`,
    );
  });

  it("collapses a ya29-style Google token, whose first segment is short", () => {
    const token = `ya29.${"a0AfH6SMBx".repeat(6)}`;

    expect(redactString(token)).toBe(`[opaque:${String(token.length)}]`);
    expect(redactString(`stored ${token}`)).toBe(`stored [opaque:${String(token.length)}]`);
  });

  it("redacts the value of a credential-bearing query parameter", () => {
    expect(
      redactString("GET https://healthy.example.test/oauth/callback?code=4/0AbCD_efGH&state=zz11"),
    ).toBe("GET https://healthy.example.test/oauth/callback?code=[redacted]&state=[redacted]");
    expect(redactString("redirected to https://example.test/cb#access_token=ya29.short")).toBe(
      "redirected to https://example.test/cb#access_token=[redacted]",
    );
    expect(redactString("refresh failed: token=abc123def")).toBe(
      "refresh failed: token=[redacted]",
    );
  });

  it("collapses a long token embedded in a longer string", () => {
    expect(redactString(`upstream said ${"Zm9vYmFy_x".repeat(4)} at once`)).toBe(
      "upstream said [opaque:40] at once",
    );
  });

  it("leaves ordinary text alone", () => {
    expect(redactString("sync finished, 3 inserted")).toBe("sync finished, 3 inserted");
  });

  it("leaves a URL's host and a request path readable", () => {
    // `/` and `:` terminate a run, so the parts of a path stay short enough to
    // survive -- a redactor that ate the path would make a 500 undebuggable.
    expect(redactString("/api/providers/01JRQ8ZVME000000000000000Z/refresh-token")).toBe(
      "/api/providers/01JRQ8ZVME000000000000000Z/refresh-token",
    );
    expect(redactString("GET https://fhir.example.test/api/FHIR/R4/Encounter failed")).toBe(
      "GET https://fhir.example.test/api/FHIR/R4/Encounter failed",
    );
  });
});

describe("redactValue", () => {
  it("redacts on a credential-shaped key whatever the value is", () => {
    for (const key of [
      "accessToken",
      "refresh_token",
      "client_secret",
      "password",
      "authorization",
      "Cookie",
      "code_verifier",
      "apiKey",
      "privateKey",
    ]) {
      expect(redactValue(key, "anything"), key).toBe("[redacted]");
    }
  });

  it("redacts `code` and `state` only as whole names", () => {
    expect(redactValue("code", "4/0Ab")).toBe("[redacted]");
    expect(redactValue("state", "e3b0c442")).toBe("[redacted]");
    // ...so the codes this project logs deliberately survive.
    expect(redactValue("errorCode", "needs_reauth")).toBe("needs_reauth");
    expect(redactValue("error_code", "invalid_grant")).toBe("invalid_grant");
    expect(redactValue("statusCode", 503)).toBe(503);
    expect(redactValue("eventState", "ghost")).toBe("ghost");
  });

  it("redacts a patient or FHIR identifier by key, whatever its shape", () => {
    // A 24-character Epic id is far below the opaque threshold, so only the key
    // rule catches it. `providerId` is one of ours and stays readable.
    // Invented, not read from any record; it is base64url-shaped enough that the
    // secret scanner takes it for a key, hence the allow.
    const epicShapedId = "eXY3NzY0NTIzNDU2Nzg5MD"; // gitleaks:allow -- synthetic fixture, not a credential
    for (const key of ["patientId", "patient_fhir_id", "fhirPatientId", "fhirResourceId"]) {
      expect(redactValue(key, epicShapedId), key).toBe("[redacted]");
    }
    expect(redactValue("providerId", "01JRQ8ZVME000000000000000Z")).toBe(
      "01JRQ8ZVME000000000000000Z",
    );
    expect(redactValue("email", "owner")).toBe("[redacted]");
  });

  it("redacts a host, a domain or an origin by key: each one names a health system", () => {
    // A sending domain or a portal hostname is an organisation identity, which
    // `SECURITY.md` puts in the never-hand-to-the-logger category -- and it is far
    // under the opaque threshold, so no shape rule would catch it. The reject path
    // of the inbound-mail handler makes it an unauthenticated remote sender's
    // choice of string as well.
    for (const key of [
      "fromDomain",
      "domain",
      "senderDomain",
      "host",
      "hostname",
      "landedOrigin",
      "origin",
    ]) {
      expect(redactValue(key, "mail.example.test"), key).toBe("[redacted]");
    }
  });

  it("leaves the ghost counters alone, even though 'ghosted' contains 'host'", () => {
    // Why `host` is an exact-key rule and not a substring one: the calendar sync
    // counts ghosted events on every run and those counts are the point of the
    // Runs page.
    expect(redactValue("eventsGhosted", 3)).toBe(3);
    expect(redactValue("ghosted", 3)).toBe(3);
    expect(redactValue("ghost_color_id", "8")).toBe("8");
  });

  it("keeps a stable error code readable under the name this project uses for one", () => {
    // The bare key `code` names the OAuth authorization code and is dropped
    // wholesale, which is why every stable code travels as `errorCode`. An
    // `/api` rejection logged under `code` read "[redacted]" in production.
    expect(redactValue("errorCode", "portal_redirected_offsite")).toBe("portal_redirected_offsite");
    expect(redactValue("error_code", "bad_request")).toBe("bad_request");
    expect(redactValue("statusCode", 404)).toBe(404);
    expect(redactValue("code", "bad_request")).toBe("[redacted]");
  });

  it("recurses into nested objects and arrays", () => {
    expect(
      redactValue("outer", {
        counts: { inserted: 2 },
        auth: { access_token: "secret-value" },
        who: ["owner@example.test", "someone@example.test"],
      }),
    ).toStrictEqual({
      counts: { inserted: 2 },
      auth: { access_token: "[redacted]" },
      who: ["[email]", "[email]"],
    });
  });

  it("passes non-strings through untouched", () => {
    expect(redactValue("count", 42)).toBe(42);
    expect(redactValue("ok", true)).toBe(true);
    expect(redactValue("missing", null)).toBeNull();
  });
});

describe("redactFields", () => {
  it("applies key and value rules across the whole record", () => {
    expect(
      redactFields({ tool: "get_appointments", token: "abc", note: "for owner@example.test" }),
    ).toStrictEqual({ tool: "get_appointments", token: "[redacted]", note: "for [email]" });
  });
});

describe("errorFields", () => {
  it("names the error and keeps its stable code and status", () => {
    expect(errorFields(new AppError("needs_reauth", "refresh rejected"))).toStrictEqual({
      errorName: "AppError",
      errorMessage: "refresh rejected",
      status: 409,
      errorCode: "needs_reauth",
    });
  });

  it("redacts the message, which may quote an upstream response", () => {
    expect(errorFields(new Error("rejected Bearer abc123"))).toMatchObject({
      errorMessage: "rejected Bearer [redacted]",
    });
  });

  it("handles a thrown non-Error", () => {
    expect(errorFields("owner@example.test failed")).toStrictEqual({ error: "[email] failed" });
  });
});

describe("makeLogger", () => {
  it("emits one JSON object per line with level, event and timestamp", () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const { log, lines, levels } = collector({}, { now: () => at });

    log.info("sync.start", { providerCount: 2 });

    expect(levels).toStrictEqual(["info"]);
    expect(lines[0]).toStrictEqual({
      level: "info",
      event: "sync.start",
      t: "2026-01-01T00:00:00.000Z",
      providerCount: 2,
    });
  });

  it("merges base fields into every line, redacted too", () => {
    const { log, lines } = collector({ run: "abc", token: "leaky" });

    log.warn("sync.slow");
    log.error("sync.fail");

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.run).toBe("abc");
      expect(line.token).toBe("[redacted]");
    }
  });

  it("drops anything below the minimum level", () => {
    const { log, lines } = collector({}, { minLevel: "warn" });

    log.debug("a");
    log.info("b");
    log.warn("c");
    log.error("d");

    expect(lines.map((line) => line.event)).toStrictEqual(["c", "d"]);
  });

  it("lets a child add fields without touching its parent", () => {
    const { log, lines } = collector({ run: "abc" });

    log.child({ providerId: "p1" }).info("provider.start");
    log.info("run.start");

    expect(lines[0]).toMatchObject({ run: "abc", providerId: "p1" });
    expect(lines[1]).not.toHaveProperty("providerId");
  });

  it("times a successful operation and reports what the caller asks it to", async () => {
    const { log, lines } = collector();

    const value = await log.time(
      "fetch",
      () => Promise.resolve([1, 2, 3]),
      (rows) => ({ count: rows.length }),
    );

    expect(value).toStrictEqual([1, 2, 3]);
    expect(lines[0]).toMatchObject({ level: "info", event: "fetch.ok", count: 3 });
    expect(lines[0]?.ms).toBeTypeOf("number");
  });

  it("times a failure, logs the error fields, and rethrows", async () => {
    const { log, lines } = collector();

    await expect(
      log.time("fetch", () => Promise.reject(new AppError("upstream_unavailable", "gave up"))),
    ).rejects.toThrow(AppError);

    expect(lines[0]).toMatchObject({
      level: "error",
      event: "fetch.fail",
      errorCode: "upstream_unavailable",
    });
  });

  it("survives a self-referential field instead of overflowing the stack", () => {
    const { log, lines } = collector();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    log.info("weird", { cyclic });

    expect(lines[0]).toMatchObject({ event: "weird" });
    expect(JSON.stringify(lines[0])).toContain("[deep]");
  });
});

function swallow(): void {
  // The spy must not print; anything it captured is asserted on instead.
}

describe("logLine", () => {
  it("writes one redacted JSON object, for the handlers with no logger", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(swallow);

    logLine("error", "unhandled", {
      errorMessage: "Invalid time zone specified: owner@example.test",
      path: "/api/runs",
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(spy.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(line).toMatchObject({
      level: "error",
      event: "unhandled",
      errorMessage: "Invalid time zone specified: [email]",
      path: "/api/runs",
    });
    expect(line.t).toBeTypeOf("string");
    spy.mockRestore();
  });
});

describe("noopLogger", () => {
  it("writes nothing to the console", () => {
    const spies = [
      vi.spyOn(console, "log").mockImplementation(swallow),
      vi.spyOn(console, "warn").mockImplementation(swallow),
      vi.spyOn(console, "error").mockImplementation(swallow),
    ];

    noopLogger.info("ignored");
    noopLogger.warn("ignored");
    noopLogger.error("ignored");

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});
