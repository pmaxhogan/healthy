import { describe, expect, it } from "vitest";

import { PASSWORD_HASH_PATTERN } from "@shared/password.ts";

import {
  MAX_PBKDF2_ITERATIONS,
  MIN_PBKDF2_ITERATIONS,
  hashPassword,
  isCostUnsupported,
  verifyPassword,
} from "../../../worker/auth/password.ts";

// The lowest cost the verifier will accept. Using exactly the floor keeps the
// suite fast while still exercising the real code path; the *production* cost is
// asserted against the real workerd runtime in the integration suite.
const COST = MIN_PBKDF2_ITERATIONS;
const PASSWORD = "correct horse battery staple";

describe("hashPassword", () => {
  it("produces the documented envelope", async () => {
    const stored = await hashPassword(PASSWORD, COST);

    expect(stored).toMatch(PASSWORD_HASH_PATTERN);
    expect(stored.split("$", 3)[2]).toBe(String(COST));
  });

  it("salts each hash, so the same password never hashes the same way twice", async () => {
    const a = await hashPassword(PASSWORD, COST);
    const b = await hashPassword(PASSWORD, COST);

    expect(a).not.toBe(b);
    await expect(verifyPassword(PASSWORD, a)).resolves.toBe(true);
    await expect(verifyPassword(PASSWORD, b)).resolves.toBe(true);
  });
});

describe("verifyPassword", () => {
  it("accepts the right password", async () => {
    const stored = await hashPassword(PASSWORD, COST);

    await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(true);
  });

  it("rejects the wrong password", async () => {
    const stored = await hashPassword(PASSWORD, COST);

    await expect(verifyPassword("Correct horse battery staple", stored)).resolves.toBe(false);
    await expect(verifyPassword("", stored)).resolves.toBe(false);
    await expect(verifyPassword(`${PASSWORD} `, stored)).resolves.toBe(false);
  });

  it("refuses a hash minted below the iteration floor", async () => {
    // The point of the floor: an attacker who can rewrite PASSWORD_HASH must not
    // be able to swap in a one-iteration hash of a password they chose, because
    // the cost travels with the hash rather than being fixed in code.
    const weak = await hashPassword(PASSWORD, MIN_PBKDF2_ITERATIONS - 1); // gitleaks:allow -- fixture, not a credential

    expect(weak.split("$", 3)[2]).toBe(String(MIN_PBKDF2_ITERATIONS - 1));
    await expect(verifyPassword(PASSWORD, weak)).resolves.toBe(false);
  });

  it("returns false rather than throwing for every malformed envelope", async () => {
    const good = await hashPassword(PASSWORD, COST);
    const parts = good.split("$", 5);
    const salt = parts[3];
    const hash = parts[4];

    const malformed = [
      "",
      "not-a-hash",
      `pbkdf2$sha256$${String(COST)}$${salt ?? ""}`, // too few fields
      `pbkdf2$sha512$${String(COST)}$${salt ?? ""}$${hash ?? ""}`, // wrong digest
      `scrypt$sha256$${String(COST)}$${salt ?? ""}$${hash ?? ""}`, // wrong scheme
      `pbkdf2$sha256$abc$${salt ?? ""}$${hash ?? ""}`, // unparseable cost
      `pbkdf2$sha256$-1$${salt ?? ""}$${hash ?? ""}`, // negative cost
      `pbkdf2$sha256$${String(COST)}$$${hash ?? ""}`, // empty salt
      `pbkdf2$sha256$${String(COST)}$${salt ?? ""}$`, // empty hash
    ];

    for (const stored of malformed) {
      await expect(verifyPassword(PASSWORD, stored), stored).resolves.toBe(false);
    }
  });

  it("rejects a hash whose stored digest has been truncated", async () => {
    // PBKDF2 output is a prefix, so a truncated digest would otherwise still
    // verify against the right password while being trivially brute-forceable.
    const good = await hashPassword(PASSWORD, COST);
    const parts = good.split("$");
    parts[4] = (parts[4] ?? "").slice(0, 8);

    await expect(verifyPassword(PASSWORD, parts.join("$"))).resolves.toBe(false);
  });

  it("rejects a tampered digest of the right length", async () => {
    const good = await hashPassword(PASSWORD, COST);
    const parts = good.split("$");
    const digest = parts[4] ?? "";
    parts[4] = (digest.startsWith("A") ? "B" : "A") + digest.slice(1);

    await expect(verifyPassword(PASSWORD, parts.join("$"))).resolves.toBe(false);
  });
});

describe("isCostUnsupported", () => {
  it("flags a well-formed envelope whose cost the runtime would refuse", async () => {
    // The 2026-09-22 shape: a genuine hash, minted above the deployed PBKDF2 cap.
    // Nothing else can detect it -- local workerd derives at 600,000 quite happily.
    const atTheFloor = await hashPassword(PASSWORD, COST);
    const overCap = atTheFloor.replace(`$${String(COST)}$`, "$600000$");

    expect(isCostUnsupported(overCap)).toBe(true);
  });

  it("says nothing about a hash at the supported cost", async () => {
    expect(isCostUnsupported(await hashPassword(PASSWORD, MAX_PBKDF2_ITERATIONS))).toBe(false);
  });

  it("stays out of the way of every other kind of bad secret", () => {
    // A missing, malformed or too-cheap secret is a failed login and nothing more:
    // reporting a misconfiguration for those would tell an attacker which one it is.
    for (const stored of ["", "not-a-hash", "pbkdf2$sha256$1$c2FsdA$aGFzaA", "pbkdf2$sha256$$$"]) {
      expect(isCostUnsupported(stored), stored).toBe(false);
    }
  });
});
