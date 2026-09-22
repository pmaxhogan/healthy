import { describe, expect, it } from "vitest";

import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  clearSessionCookie,
  issueSession,
  mintSessionToken,
  verifySession,
  type SessionEnv,
} from "../../../worker/auth/session.ts";

const ENV: SessionEnv = {
  // Not a credential: a fixed value so the HMAC is deterministic across runs.
  SESSION_SECRET: "unit-test-signing-material",
  PASSWORD_HASH: "pbkdf2$sha256$600000$c2FsdA$aGFzaA",
};

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

function requestWithCookie(value: string): Request {
  return new Request("https://healthy.example/api/whoami", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${value}` },
  });
}

describe("issueSession", () => {
  it("sets every attribute the cookie contract requires", async () => {
    const header = await issueSession(ENV, NOW);

    expect(header.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    expect(header).toContain(`Max-Age=${String(SESSION_TTL_SECONDS)}`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    // Strict, not Lax: this is half of the CSRF defence, so a downgrade here is a
    // security change and must fail the suite.
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/");
  });

  it("expires 30 days out", async () => {
    const token = await mintSessionToken(ENV, NOW);
    const exp = Number(token.split(".", 1)[0]);

    expect(exp).toBe(Math.floor(NOW / 1000) + SESSION_TTL_SECONDS);
    expect(SESSION_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  it("throws rather than minting an unsigned session when a secret is missing", async () => {
    await expect(mintSessionToken({ PASSWORD_HASH: ENV.PASSWORD_HASH }, NOW)).rejects.toThrow();
    await expect(mintSessionToken({ SESSION_SECRET: ENV.SESSION_SECRET }, NOW)).rejects.toThrow();
  });
});

describe("verifySession", () => {
  it("accepts a freshly minted token", async () => {
    const token = await mintSessionToken(ENV, NOW);

    await expect(verifySession(requestWithCookie(token), ENV, NOW)).resolves.toBe(true);
  });

  it("rejects a request with no cookie at all", async () => {
    const request = new Request("https://healthy.example/api/whoami");

    await expect(verifySession(request, ENV, NOW)).resolves.toBe(false);
  });

  it("rejects a token past its expiry", async () => {
    const token = await mintSessionToken(ENV, NOW);
    const justAfter = NOW + (SESSION_TTL_SECONDS + 1) * 1000;

    await expect(verifySession(requestWithCookie(token), ENV, justAfter)).resolves.toBe(false);
  });

  it("rejects a tampered expiry, because exp is inside the signed message", async () => {
    const token = await mintSessionToken(ENV, NOW);
    const [exp, signature] = token.split(".", 2);
    const extended = `${String(Number(exp) + 86_400)}.${signature ?? ""}`;

    await expect(verifySession(requestWithCookie(extended), ENV, NOW)).resolves.toBe(false);
  });

  it("rejects a tampered signature", async () => {
    const token = await mintSessionToken(ENV, NOW);
    const [exp, signature] = token.split(".", 2);
    const flipped = (signature ?? "").startsWith("A")
      ? `B${(signature ?? "").slice(1)}`
      : `A${(signature ?? "").slice(1)}`;

    const tampered = [exp ?? "", flipped].join(".");

    await expect(verifySession(requestWithCookie(tampered), ENV, NOW)).resolves.toBe(false);
  });

  it("rejects structurally broken cookie values without throwing", async () => {
    for (const value of ["", ".", "abc", "abc.def", "-1.AAAA", "1e9.AAAA", String(NOW)]) {
      await expect(verifySession(requestWithCookie(value), ENV, NOW), value).resolves.toBe(false);
    }
  });

  it("rejects everything when the secrets are not configured", async () => {
    const token = await mintSessionToken(ENV, NOW);
    const request = requestWithCookie(token);

    await expect(verifySession(request, {}, NOW)).resolves.toBe(false);
    await expect(verifySession(request, { SESSION_SECRET: ENV.SESSION_SECRET }, NOW)).resolves.toBe(
      false,
    );
    await expect(verifySession(request, { PASSWORD_HASH: ENV.PASSWORD_HASH }, NOW)).resolves.toBe(
      false,
    );
  });

  describe("rotation revokes every outstanding session", () => {
    it("when SESSION_SECRET changes", async () => {
      const token = await mintSessionToken(ENV, NOW);
      const rotated: SessionEnv = { ...ENV, SESSION_SECRET: "rotated-signing-material" };

      await expect(verifySession(requestWithCookie(token), rotated, NOW)).resolves.toBe(false);
    });

    it("when PASSWORD_HASH changes -- changing the admin password logs sessions out", async () => {
      const token = await mintSessionToken(ENV, NOW);
      const rotated: SessionEnv = {
        ...ENV,
        PASSWORD_HASH: "pbkdf2$sha256$600000$b3RoZXI$b3RoZXJoYXNo",
      };

      await expect(verifySession(requestWithCookie(token), rotated, NOW)).resolves.toBe(false);
    });
  });

  it("ignores other cookies sitting alongside it", async () => {
    const token = await mintSessionToken(ENV, NOW);
    const request = new Request("https://healthy.example/api/whoami", {
      headers: {
        cookie: `CF_Authorization=irrelevant; ${SESSION_COOKIE_NAME}=${token}; other=x`,
      },
    });

    await expect(verifySession(request, ENV, NOW)).resolves.toBe(true);
  });
});

describe("clearSessionCookie", () => {
  it("expires the cookie immediately, with the same attributes it was set with", () => {
    const header = clearSessionCookie();

    expect(header.startsWith(`${SESSION_COOKIE_NAME}=;`)).toBe(true);
    expect(header).toContain("Max-Age=0");
    // A browser only replaces a cookie when the name, Path and attributes match,
    // so a mismatch here would leave the old cookie in place.
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/");
  });
});
