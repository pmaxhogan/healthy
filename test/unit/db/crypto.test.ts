import { describe, expect, it, vi } from "vitest";

import { aadFor, isSealed, open, openOrNull, seal } from "../../../worker/db/crypto.ts";
import { AppError } from "../../../worker/lib/errors.ts";

import type { KeySource } from "../../../worker/db/crypto.ts";

function freshKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
}

const KEY = freshKey();
const AAD = aadFor("connections", "access_token_enc", "c1");

describe("aadFor", () => {
  it("names one cell", () => {
    expect(aadFor("providers", "client_secret_enc", "p1")).toBe("providers.client_secret_enc.p1");
    // The Google row's id is the number 1; the AAD is still a string.
    expect(aadFor("google_account", "refresh_token_enc", 1)).toBe(
      "google_account.refresh_token_enc.1",
    );
    // The FHIR cache's row id is a composite of its three key columns.
    expect(aadFor("fhir_cache", "payload", "p1:Encounter:e1")).toBe(
      "fhir_cache.payload.p1:Encounter:e1",
    );
  });
});

describe("seal", () => {
  it("round-trips through open", async () => {
    const sealed = await seal(KEY, "a-refresh-token", AAD);

    expect(await open(KEY, sealed, AAD)).toBe("a-refresh-token");
  });

  it("produces a versioned base64url envelope and nothing resembling the input", async () => {
    const sealed = await seal(KEY, "an-obviously-distinctive-plaintext", AAD);

    expect(sealed.startsWith("v1:")).toBe(true);
    expect(isSealed(sealed)).toBe(true);
    expect(sealed).not.toContain("distinctive");
    // base64url: no +, / or = padding, so the value is safe in a URL or a header.
    expect(sealed.slice(3)).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it("never produces the same ciphertext twice, because the IV is random", async () => {
    const [first, second] = await Promise.all([seal(KEY, "same", AAD), seal(KEY, "same", AAD)]);

    expect(first).not.toBe(second);
    expect(await open(KEY, second, AAD)).toBe("same");
  });

  it("handles an empty string and non-ASCII text", async () => {
    for (const plaintext of ["", "ünïcodé · 测试 · 🩺", "x".repeat(10_000)]) {
      expect(await open(KEY, await seal(KEY, plaintext, AAD), AAD)).toBe(plaintext);
    }
  });

  it("accepts an env-shaped key source as well as a raw key", async () => {
    const env: KeySource = { DATA_KEY: KEY };

    expect(await open(env, await seal(env, "either way", AAD), AAD)).toBe("either way");
  });
});

describe("open", () => {
  it("fails on the wrong AAD", async () => {
    // The whole point of the AAD: a ciphertext lifted into another row is inert.
    const sealed = await seal(KEY, "token", aadFor("connections", "access_token_enc", "c1"));

    await expect(
      open(KEY, sealed, aadFor("connections", "access_token_enc", "c2")),
    ).rejects.toThrow(AppError);
    await expect(
      open(KEY, sealed, aadFor("connections", "refresh_token_enc", "c1")),
    ).rejects.toMatchObject({ code: "crypto" });
  });

  it("fails on the wrong key", async () => {
    const sealed = await seal(KEY, "token", AAD);

    await expect(open(freshKey(), sealed, AAD)).rejects.toMatchObject({ code: "crypto" });
  });

  it("fails on a tampered ciphertext", async () => {
    const sealed = await seal(KEY, "token", AAD);
    // Flip one base64url character in the ciphertext half.
    const body = sealed.slice(3);
    const flipped = body.slice(0, -1) + (body.endsWith("A") ? "B" : "A");

    await expect(open(KEY, `v1:${flipped}`, AAD)).rejects.toMatchObject({ code: "crypto" });
  });

  it("fails on a tampered IV", async () => {
    const sealed = await seal(KEY, "token", AAD);
    const body = sealed.slice(3);
    const flipped = (body.startsWith("A") ? "B" : "A") + body.slice(1);

    await expect(open(KEY, `v1:${flipped}`, AAD)).rejects.toMatchObject({ code: "crypto" });
  });

  it("rejects a malformed envelope with the same code", async () => {
    for (const bad of ["", "not-sealed", "v2:abcdef", "v1:", "v1:AAAA", "v1:!!!!"]) {
      await expect(open(KEY, bad, AAD), bad).rejects.toMatchObject({ code: "crypto" });
    }
  });

  it("reports a missing or wrong-sized DATA_KEY as a crypto failure", async () => {
    await expect(seal({}, "x", AAD)).rejects.toMatchObject({ code: "crypto" });
    await expect(seal({ DATA_KEY: "" }, "x", AAD)).rejects.toMatchObject({ code: "crypto" });
    const tooShort = Buffer.from(new Uint8Array(16)).toString("base64");

    await expect(seal(tooShort, "x", AAD)).rejects.toThrow(/32 bytes/);
    await expect(seal("not base64 at all !!", "x", AAD)).rejects.toMatchObject({ code: "crypto" });
  });

  it("does not cache a failed key import", async () => {
    // A poisoned cache entry would turn one bad deploy into a dead isolate.
    const bad = Buffer.from(new Uint8Array(8)).toString("base64");

    await expect(seal(bad, "x", AAD)).rejects.toMatchObject({ code: "crypto" });
    await expect(seal(bad, "x", AAD)).rejects.toMatchObject({ code: "crypto" });
  });
});

describe("openOrNull", () => {
  it("passes a NULL column through", async () => {
    expect(await openOrNull(KEY, null, AAD)).toBeNull();
    expect(await openOrNull(KEY, await seal(KEY, "value", AAD), AAD)).toBe("value");
  });
});

describe("isSealed", () => {
  it("recognises the envelope without trying to open it", () => {
    expect(isSealed("v1:AAAA")).toBe(true);
    expect(isSealed("plaintext-secret")).toBe(false);
  });
});

describe("the key cache", () => {
  it("imports one CryptoKey per distinct secret, however many cells it seals", async () => {
    // This is the whole reason for the module-scope cache: a full refresh seals
    // thousands of payloads per invocation and must not re-derive the key each time.
    const key = freshKey();
    const spy = vi.spyOn(crypto.subtle, "importKey");
    try {
      await Promise.all([
        seal(key, "a", AAD),
        seal(key, "b", AAD),
        seal(key, "c", AAD),
        seal(key, "d", AAD),
      ]);
      await open(key, await seal(key, "e", AAD), AAD);

      expect(spy.mock.calls).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
