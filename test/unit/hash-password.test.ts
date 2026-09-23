import { describe, expect, it } from "vitest";

import {
  MAX_PBKDF2_ITERATIONS,
  PASSWORD_HASH_PATTERN,
  PBKDF2_ITERATIONS,
} from "@shared/password.ts";

import { generatePassword, hashPassword, verifyPassword } from "../../scripts/hash-password.ts";

// A low cost keeps the suite fast; the format and the verification logic are
// what is under test, and both are independent of the iteration count. The
// production count is exercised once, in the integration suite, against workerd.
const FAST = 1000;

describe("hashPassword", () => {
  it("produces the documented pbkdf2$sha256$iter$salt$hash envelope", () => {
    const encoded = hashPassword("correct horse battery staple", FAST);
    const parts = encoded.split("$");

    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe("pbkdf2");
    expect(parts[1]).toBe("sha256");
    expect(parts[2]).toBe(String(FAST));
    // base64url: no +, / or = padding, so the whole thing is safe in a header,
    // a URL, or a shell argument.
    expect(encoded).toMatch(PASSWORD_HASH_PATTERN);
  });

  it("salts every hash, so the same password never encodes twice the same", () => {
    expect(hashPassword("same", FAST)).not.toBe(hashPassword("same", FAST));
  });

  it("defaults to the production iteration count", () => {
    expect(hashPassword("x")).toContain(`$${String(PBKDF2_ITERATIONS)}$`);
  });

  it("refuses to mint a hash deployed workerd cannot derive", () => {
    // The 2026-09-22 incident: a 600,000-iteration secret verified locally and
    // 500'd the first production login.
    expect(() => hashPassword("x", MAX_PBKDF2_ITERATIONS + 1)).toThrow(RangeError);
    expect(() => hashPassword("x", 600_000)).toThrow(/not supported/);
  });
});

describe("verifyPassword", () => {
  it("accepts the right password and rejects a wrong one", () => {
    const encoded = hashPassword("s3cret-passphrase", FAST);

    expect(verifyPassword("s3cret-passphrase", encoded)).toBe(true);
    expect(verifyPassword("s3cret-passphras", encoded)).toBe(false);
    expect(verifyPassword("", encoded)).toBe(false);
  });

  it("reads the iteration count out of the envelope rather than assuming one", () => {
    // Proves an existing secret keeps working after PBKDF2_ITERATIONS is raised.
    expect(verifyPassword("legacy", hashPassword("legacy", 2000))).toBe(true);
  });

  it("rejects malformed stored values instead of throwing", () => {
    for (const bad of [
      "",
      "not-a-hash",
      "pbkdf2$sha256$1000$onlyfourparts",
      "pbkdf2$sha512$1000$c2FsdA$aGFzaA",
      "scrypt$sha256$1000$c2FsdA$aGFzaA",
      "pbkdf2$sha256$0$c2FsdA$aGFzaA",
      "pbkdf2$sha256$abc$c2FsdA$aGFzaA",
      "pbkdf2$sha256$1000$$aGFzaA",
    ]) {
      expect(verifyPassword("anything", bad), bad).toBe(false);
    }
  });
});

describe("generatePassword", () => {
  it("returns 24 unambiguous base58 characters", () => {
    const password = generatePassword();

    expect(password).toHaveLength(24);
    // No 0/O/I/l: the password gets read off a screen and retyped.
    expect(password).toMatch(/^[1-9A-HJ-NP-Za-km-z]{24}$/u);
  });
});
