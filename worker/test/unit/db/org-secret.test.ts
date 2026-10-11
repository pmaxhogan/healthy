// Derived per-organisation client secrets: deterministic, keyed, and separated
// by environment and organisation, in the one output shape Epic's form is known
// to accept.

import { createHmac, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ORG_ID_PATTERN, deriveOrgClientSecret } from "../../../src/db/org-secret.ts";

// Synthetic organisation ids -- not any real organisation's.
const ORG = "99001";
const OTHER_ORG = "99002";

function freshKey(): string {
  return randomBytes(32).toString("base64");
}

describe("deriveOrgClientSecret", () => {
  it("is 64 lowercase hex characters, and the same every time", async () => {
    const key = freshKey();

    const secret = await deriveOrgClientSecret(key, "prod", ORG);

    expect(secret).toMatch(/^[0-9a-f]{64}$/u);
    expect(await deriveOrgClientSecret(key, "prod", ORG)).toBe(secret);
  });

  it("is HMAC-SHA256 over the domain, the environment and the organisation id", async () => {
    // Recomputed independently: the registered secrets outlive this code, so the
    // construction is pinned rather than only compared with itself.
    const key = freshKey();
    const expected = (environment: string): string =>
      createHmac("sha256", Buffer.from(key, "base64"))
        .update(`healthy/epic-org-secret/v1\u{0}${environment}\u{0}${ORG}`)
        .digest("hex");

    expect(await deriveOrgClientSecret(key, "prod", ORG)).toBe(expected("prod"));
    expect(await deriveOrgClientSecret(key, "sandbox", ORG)).toBe(expected("nonprod"));
  });

  it("differs by environment, by organisation and by key", async () => {
    const key = freshKey();
    const secret = await deriveOrgClientSecret(key, "prod", ORG);

    expect(await deriveOrgClientSecret(key, "sandbox", ORG)).not.toBe(secret);
    expect(await deriveOrgClientSecret(key, "prod", OTHER_ORG)).not.toBe(secret);
    expect(await deriveOrgClientSecret(freshKey(), "prod", ORG)).not.toBe(secret);
  });

  it("does not normalise the organisation id", async () => {
    const key = freshKey();

    expect(await deriveOrgClientSecret(key, "prod", "0123")).not.toBe(
      await deriveOrgClientSecret(key, "prod", "123"),
    );
  });

  it("refuses a key that is not 32 bytes of base64", async () => {
    await expect(deriveOrgClientSecret("", "prod", ORG)).rejects.toMatchObject({ code: "crypto" });
    await expect(deriveOrgClientSecret("not base64!", "prod", ORG)).rejects.toMatchObject({
      code: "crypto",
    });
    await expect(
      deriveOrgClientSecret(randomBytes(16).toString("base64"), "prod", ORG),
    ).rejects.toMatchObject({ code: "crypto" });
  });

  it("refuses an organisation id outside the expected format", async () => {
    const key = freshKey();

    for (const orgId of ["", " 123", "12 3", "123\n", "a".repeat(65)]) {
      expect(ORG_ID_PATTERN.test(orgId), JSON.stringify(orgId)).toBe(false);
      await expect(deriveOrgClientSecret(key, "prod", orgId)).rejects.toMatchObject({
        code: "crypto",
      });
    }
  });
});
