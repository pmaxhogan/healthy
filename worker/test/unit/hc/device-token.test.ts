// The device bearer token: shape, digest and comparison. Plain Node; the same
// code runs in workerd.

import { describe, expect, it } from "vitest";

import {
  bearerDeviceToken,
  hashDeviceToken,
  mintDeviceToken,
  parseDeviceToken,
  verifyDeviceToken,
} from "../../../src/hc/device-token.ts";
import { newId } from "../../../src/lib/ids.ts";

describe("mintDeviceToken", () => {
  it("names its device and carries 256 fresh random bits", () => {
    const deviceId = newId();
    const first = mintDeviceToken(deviceId);
    const second = mintDeviceToken(deviceId);

    expect(first.startsWith(`hcd1.${deviceId}.`)).toBe(true);
    expect(first.slice(first.lastIndexOf(".") + 1)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(second).not.toBe(first);
  });
});

describe("parseDeviceToken", () => {
  const deviceId = newId();
  const token = mintDeviceToken(deviceId);

  it("round-trips a minted token", () => {
    expect(parseDeviceToken(token)).toStrictEqual({ deviceId, token });
  });

  it.each([
    ["empty", ""],
    ["another version", token.replace("hcd1", "hcd2")],
    ["a short secret", token.slice(0, -1)],
    ["a long secret", `${token}A`],
    ["a secret outside the alphabet", `${token.slice(0, -1)}+`],
    ["an id this app would not mint", token.replace(deviceId, "not-an-id")],
    ["an extra part", `${token}.x`],
    ["oversized input", `hcd1.${deviceId}.${"A".repeat(4000)}`],
  ])("refuses %s", (_name, candidate) => {
    expect(parseDeviceToken(candidate)).toBeNull();
  });
});

describe("bearerDeviceToken", () => {
  const token = mintDeviceToken(newId());

  it("reads a Bearer header", () => {
    expect(bearerDeviceToken(`Bearer ${token}`)?.token).toBe(token);
  });

  it.each([
    ["no header", null],
    ["undefined", undefined],
    ["the bare token", token],
    ["another scheme", `Basic ${token}`],
    ["a lower-case scheme", `bearer ${token}`],
    ["two spaces", `Bearer  ${token}`],
  ])("refuses %s", (_name, header) => {
    expect(bearerDeviceToken(header)).toBeNull();
  });
});

describe("verifyDeviceToken", () => {
  it("accepts the token whose digest is stored and nothing else", async () => {
    const deviceId = newId();
    const token = mintDeviceToken(deviceId);
    const stored = await hashDeviceToken(token);

    expect(stored).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(stored).not.toContain(token.slice(token.lastIndexOf(".") + 1));
    await expect(verifyDeviceToken(token, stored)).resolves.toBe(true);
    await expect(verifyDeviceToken(mintDeviceToken(deviceId), stored)).resolves.toBe(false);
    await expect(verifyDeviceToken(token, "A".repeat(43))).resolves.toBe(false);
    await expect(verifyDeviceToken(token, "")).resolves.toBe(false);
  });
});
