// The Cloudflare Access gate, tested against a real RS256 signature.
//
// The key pair is generated here and handed to `verifyAccess` as a LOCAL JWKS, so
// nothing reaches the network and the test still exercises the actual `jwtVerify`
// call with its real audience, issuer, algorithm and expiry checks. Only the key
// *resolver* is substituted; the verification itself is production code.

import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";

import { verifyAccess, type AccessEnv } from "../../../worker/auth/access.ts";

const TEAM = "example-team.cloudflareaccess.com";
const AUD = "a".repeat(64);
const ALLOWED_EMAIL = "owner@example.test";

const ENV: AccessEnv = {
  DEV_MODE: "false",
  CF_ACCESS_TEAM_DOMAIN: TEAM,
  CF_ACCESS_AUD: AUD,
  CF_ACCESS_ALLOWED_EMAIL: ALLOWED_EMAIL,
};

// Top-level await rather than a `beforeAll`: the key pair is immutable test
// fixture data, and this way every test sees a `const` instead of a `let` that a
// hook happens to fill in first. `extractable` is required or `exportJWK` throws.
const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
const getKey = createLocalJWKSet({
  keys: [{ ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256" }],
});

interface Claims {
  email?: unknown;
  audience?: string;
  issuer?: string;
  expiresIn?: string;
}

async function sign(claims: Claims = {}): Promise<string> {
  const payload = claims.email === undefined ? {} : { email: claims.email };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuedAt()
    .setIssuer(claims.issuer ?? `https://${TEAM}`)
    .setAudience(claims.audience ?? AUD)
    .setExpirationTime(claims.expiresIn ?? "1h")
    .sign(privateKey);
}

function requestWith(token: string, via: "header" | "cookie" = "header"): Request {
  const headers =
    via === "header"
      ? { "cf-access-jwt-assertion": token }
      : { cookie: `CF_Authorization=${token}` };
  return new Request("https://healthy.example/api/whoami", { headers });
}

describe("verifyAccess", () => {
  it("accepts a valid assertion for the allowed identity", async () => {
    const token = await sign({ email: ALLOWED_EMAIL });

    await expect(verifyAccess(requestWith(token), ENV, { getKey })).resolves.toBe(true);
  });

  it("reads the assertion from the CF_Authorization cookie as well as the header", async () => {
    // Header on a proxied fetch, cookie on a browser navigation; both are Access.
    const token = await sign({ email: ALLOWED_EMAIL });

    await expect(verifyAccess(requestWith(token, "cookie"), ENV, { getKey })).resolves.toBe(true);
  });

  describe("the email claim", () => {
    it("is compared case-insensitively", async () => {
      const token = await sign({ email: "OWNER@Example.TEST" });

      await expect(verifyAccess(requestWith(token), ENV, { getKey })).resolves.toBe(true);
    });

    it("rejects a different identity even though the signature is valid", async () => {
      // The whole point of this check: an Access policy widened by accident in the
      // dashboard would otherwise hand the medical record to whoever it let in.
      const token = await sign({ email: "someone.else@example.test" });

      await expect(verifyAccess(requestWith(token), ENV, { getKey })).resolves.toBe(false);
    });

    it("rejects a lookalike address", async () => {
      for (const email of [
        "owner@example.test.evil.example",
        "owner@example.tes",
        " owner@example.test.",
        "xowner@example.test",
      ]) {
        const token = await sign({ email });
        await expect(verifyAccess(requestWith(token), ENV, { getKey }), email).resolves.toBe(false);
      }
    });

    it("rejects a token with no email claim, or a non-string one", async () => {
      for (const email of [undefined, null, 42, { address: ALLOWED_EMAIL }, [ALLOWED_EMAIL]]) {
        const token = await sign(email === undefined ? {} : { email });
        await expect(
          verifyAccess(requestWith(token), ENV, { getKey }),
          JSON.stringify(email),
        ).resolves.toBe(false);
      }
    });
  });

  it("rejects a token issued for another Access application", async () => {
    const token = await sign({ email: ALLOWED_EMAIL, audience: "b".repeat(64) });

    await expect(verifyAccess(requestWith(token), ENV, { getKey })).resolves.toBe(false);
  });

  it("rejects a token from another team domain", async () => {
    const token = await sign({
      email: ALLOWED_EMAIL,
      issuer: "https://other.cloudflareaccess.com",
    });

    await expect(verifyAccess(requestWith(token), ENV, { getKey })).resolves.toBe(false);
  });

  it("rejects an expired token beyond the 30s clock tolerance", async () => {
    const token = await sign({ email: ALLOWED_EMAIL, expiresIn: "-5m" });

    await expect(verifyAccess(requestWith(token), ENV, { getKey })).resolves.toBe(false);
  });

  it("accepts a token that expired within the clock tolerance", async () => {
    // Access tokens are short-lived and the signer's clock is not this Worker's.
    const token = await sign({ email: ALLOWED_EMAIL, expiresIn: "-10s" });

    await expect(verifyAccess(requestWith(token), ENV, { getKey })).resolves.toBe(true);
  });

  it("rejects a request with no assertion at all", async () => {
    const request = new Request("https://healthy.example/api/whoami");

    await expect(verifyAccess(request, ENV, { getKey })).resolves.toBe(false);
  });

  it("rejects garbage in place of a token without throwing", async () => {
    for (const token of ["", "not.a.jwt", "a.b.c"]) {
      await expect(verifyAccess(requestWith(token), ENV, { getKey }), token).resolves.toBe(false);
    }
  });

  describe("fails closed on misconfiguration", () => {
    it("when the allowed email is unset", async () => {
      const token = await sign({ email: ALLOWED_EMAIL });
      const env: AccessEnv = { ...ENV, CF_ACCESS_ALLOWED_EMAIL: undefined };

      await expect(verifyAccess(requestWith(token), env, { getKey })).resolves.toBe(false);
    });

    it("when the team domain or the AUD is unset", async () => {
      const token = await sign({ email: ALLOWED_EMAIL });

      await expect(
        verifyAccess(requestWith(token), { ...ENV, CF_ACCESS_TEAM_DOMAIN: undefined }, { getKey }),
      ).resolves.toBe(false);
      await expect(
        verifyAccess(requestWith(token), { ...ENV, CF_ACCESS_AUD: undefined }, { getKey }),
      ).resolves.toBe(false);
    });
  });

  describe("DEV_MODE", () => {
    it('skips the gate entirely when it is exactly "true"', async () => {
      // There is no Access in front of `wrangler dev` or the integration tests.
      // The password gate still applies -- this relaxes THIS gate and no other.
      const request = new Request("https://healthy.example/api/whoami");

      await expect(verifyAccess(request, { DEV_MODE: "true" })).resolves.toBe(true);
    });

    it("is not enabled by any other truthy-looking value", async () => {
      const request = new Request("https://healthy.example/api/whoami");

      for (const value of ["1", "yes", "TRUE", "True", " true", ""]) {
        await expect(
          verifyAccess(request, { DEV_MODE: value }),
          JSON.stringify(value),
        ).resolves.toBe(false);
      }
    });
  });
});
