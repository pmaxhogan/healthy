import { describe, expect, it } from "vitest";

import {
  base64UrlEncode,
  challengeS256,
  createPkce,
  randomState,
  randomVerifier,
} from "../../../worker/providers/pkce.ts";

import type { Pkce } from "../../../worker/providers/pkce.ts";

const UNRESERVED = /^[A-Za-z0-9\-._~]+$/u;
const BASE64URL = /^[A-Za-z0-9\-_]+$/u;

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("base64UrlEncode", () => {
  it("matches RFC 4648 for every padding length, without emitting padding", () => {
    expect(base64UrlEncode(bytes(""))).toBe("");
    expect(base64UrlEncode(bytes("f"))).toBe("Zg");
    expect(base64UrlEncode(bytes("fo"))).toBe("Zm8");
    expect(base64UrlEncode(bytes("foo"))).toBe("Zm9v");
    expect(base64UrlEncode(bytes("foob"))).toBe("Zm9vYg");
    expect(base64UrlEncode(bytes("fooba"))).toBe("Zm9vYmE");
    expect(base64UrlEncode(bytes("foobar"))).toBe("Zm9vYmFy");
  });

  it("uses the URL alphabet, so no + or / can appear", () => {
    // 0xFB 0xFF encodes to "+/8=" in standard base64.
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff, 0xff]))).toBe("-___");
  });
});

describe("challengeS256", () => {
  it("reproduces the RFC 7636 appendix B test vector", async () => {
    await expect(challengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).resolves.toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("randomVerifier", () => {
  it("is 64 unreserved characters by default", () => {
    const verifier = randomVerifier();

    expect(verifier).toHaveLength(64);
    expect(verifier).toMatch(UNRESERVED);
  });

  it("does not repeat", () => {
    expect(randomVerifier()).not.toBe(randomVerifier());
  });

  it("rejects lengths RFC 7636 forbids", () => {
    expect(() => randomVerifier(42)).toThrow(RangeError);
    expect(() => randomVerifier(129)).toThrow(RangeError);
    expect(randomVerifier(43)).toHaveLength(43);
    expect(randomVerifier(128)).toHaveLength(128);
  });
});

describe("randomState", () => {
  it("is 43 base64url characters from 32 random bytes", () => {
    const state = randomState();

    expect(state).toHaveLength(43);
    expect(state).toMatch(BASE64URL);
    expect(state).not.toBe(randomState());
  });
});

describe("createPkce", () => {
  it("returns a verifier whose S256 challenge is the one it reports", async () => {
    const pkce: Pkce = await createPkce();

    expect(pkce.method).toBe("S256");
    expect(pkce.verifier).toHaveLength(64);
    await expect(challengeS256(pkce.verifier)).resolves.toBe(pkce.challenge);
    expect(pkce.challenge).toMatch(BASE64URL);
  });
});
