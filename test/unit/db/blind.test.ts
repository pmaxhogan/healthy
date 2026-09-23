// Keyed blinding and padded sealing: the two primitives 0007 is built on.
//
// Blinding has to be deterministic (it is a primary key and an index), keyed (a
// snapshot reader without DATA_KEY cannot recompute or confirm it), domain
// separated (the same id blinded for two columns is two unrelated values), and
// derived rather than being the AES key itself. Padding has to hide the exact
// length of a short value while still round-tripping, and must not weaken the
// AAD binding.

import { describe, expect, it } from "vitest";

import {
  blindCalendarId,
  blindCsn,
  blindEventKey,
  blindResourceId,
  blinderFor,
  isBlinded,
  isBlindedEventKey,
} from "../../../worker/db/blind.ts";
import {
  aadFor,
  isSealed,
  isUnpadded,
  open,
  padBucket,
  seal,
  sealShort,
} from "../../../worker/db/crypto.ts";

function freshKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
}

const KEY = freshKey();
const BLINDER = blinderFor(KEY);

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Plaintext bytes a v1 envelope gives away: base64 length minus IV and tag. */
function envelopeBytes(sealed: string): number {
  return Buffer.from(sealed.slice(3), "base64url").length;
}

describe("blinderFor", () => {
  it("is deterministic for one key, domain and value", async () => {
    expect(await BLINDER.id("d", "value")).toBe(await BLINDER.id("d", "value"));
    expect(await BLINDER.digest("d", "value")).toBe(await BLINDER.digest("d", "value"));
  });

  it("is keyed: another DATA_KEY gives another blind for the same value", async () => {
    const other = blinderFor(freshKey());

    expect(await other.id("d", "value")).not.toBe(await BLINDER.id("d", "value"));
    expect(await other.digest("d", "value")).not.toBe(await BLINDER.digest("d", "value"));
  });

  it("separates domains, and a domain cannot be re-split into another pair", async () => {
    expect(await BLINDER.id("a", "value")).not.toBe(await BLINDER.id("b", "value"));
    expect(await BLINDER.id("a:b", "c")).not.toBe(await BLINDER.id("a", "b:c"));
  });

  it("is not a plain sha256 of the input, with or without the domain", async () => {
    const digest = await BLINDER.digest("d", "value");

    expect(digest).not.toContain(await sha256Hex("value"));
    expect(digest).not.toContain(await sha256Hex("d\u{0}value"));
  });

  it("uses a derived HMAC key, not the AES key: the raw key as an HMAC key gives another value", async () => {
    const raw = await crypto.subtle.importKey(
      "raw",
      Buffer.from(KEY, "base64"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const direct = new Uint8Array(
      await crypto.subtle.sign("HMAC", raw, new TextEncoder().encode("d\u{0}value")),
    );

    expect(await BLINDER.digest("d", "value")).not.toBe(
      `~${Buffer.from(direct).toString("base64url")}`,
    );
  });

  it("marks what it produces, and 128 bits for an id, 256 for a digest", async () => {
    const id = await BLINDER.id("d", "value");
    const digest = await BLINDER.digest("d", "value");

    expect(id).toMatch(/^~[\w-]{22}$/u);
    expect(digest).toMatch(/^~[\w-]{43}$/u);
    expect(isBlinded(id)).toBe(true);
    expect(isBlinded("eAbc-123.x")).toBe(false);
  });

  it("refuses a missing or malformed key rather than blinding with nothing", async () => {
    await expect(blinderFor({}).id("d", "v")).rejects.toMatchObject({ code: "crypto" });
    await expect(blinderFor("dGVzdA==").id("d", "v")).rejects.toMatchObject({ code: "crypto" });
  });
});

describe("the named blinds", () => {
  it("bind every identifier to its health system", async () => {
    expect(await blindResourceId(BLINDER, "p1", "Patient", "x")).not.toBe(
      await blindResourceId(BLINDER, "p2", "Patient", "x"),
    );
    expect(await blindCsn(BLINDER, "p1", "c")).not.toBe(await blindCsn(BLINDER, "p2", "c"));
    expect(await blindResourceId(BLINDER, "p1", "Patient", "x")).not.toBe(
      await blindResourceId(BLINDER, "p1", "Encounter", "x"),
    );
  });

  it("blinds the calendar id, which is usually an email address", async () => {
    const blinded = await blindCalendarId(BLINDER, "owner@example.test");

    expect(blinded).not.toContain("owner");
    expect(blinded).toBe(await blindCalendarId(BLINDER, "owner@example.test"));
  });

  it("keeps an event key's health system prefix and portal marker, and nothing upstream", async () => {
    const fhir = await blindEventKey(BLINDER, "p1:eAbc123");
    const portal = await blindEventKey(BLINDER, "p1:csn:WP-24x");

    expect(fhir).toMatch(/^p1:~[\w-]{22}$/u);
    expect(portal).toMatch(/^p1:csn:~[\w-]{22}$/u);
    expect(fhir).not.toContain("eAbc123");
    expect(portal).not.toContain("WP-24x");
    expect(isBlindedEventKey(fhir)).toBe(true);
    expect(isBlindedEventKey(portal)).toBe(true);
    expect(isBlindedEventKey("p1:eAbc123")).toBe(false);
    expect(isBlindedEventKey("p1:csn:WP-24x")).toBe(false);
  });

  it("refuses an event key with no health system prefix", async () => {
    await expect(blindEventKey(BLINDER, "no-prefix")).rejects.toMatchObject({ code: "crypto" });
  });
});

describe("padded sealing", () => {
  it("rounds a short value up to a size bucket", () => {
    expect(padBucket(5)).toBe(64);
    expect(padBucket(64)).toBe(64);
    expect(padBucket(65)).toBe(128);
    expect(padBucket(1000)).toBe(1024);
  });

  it("gives two different short credentials the same ciphertext length", async () => {
    const aad = aadFor("portal_accounts", "password_enc", "p1");
    const short = await sealShort(KEY, "pw", aad);
    const longer = await sealShort(KEY, "a-longer-password", aad);

    expect(short.startsWith("v2:")).toBe(true);
    expect(short).toHaveLength(longer.length);
    // Unpadded, the length is the plaintext's plus a fixed overhead.
    const bare = await seal(KEY, "a-longer-password", aad);
    expect(envelopeBytes(bare) - 28).toBe("a-longer-password".length);
  });

  it("round-trips, including multi-byte text and the empty string", async () => {
    const aad = aadFor("mail_inbox", "subject_enc", "m1");
    for (const value of ["", "héllo wörld ✓", "x".repeat(300)]) {
      expect(await open(KEY, await sealShort(KEY, value, aad), aad)).toBe(value);
    }
  });

  it("keeps the AAD binding: a padded value moved to another cell does not open", async () => {
    const sealed = await sealShort(KEY, "value", aadFor("settings", "value_json", "timezone"));

    await expect(
      open(KEY, sealed, aadFor("settings", "value_json", "calendar_id")),
    ).rejects.toMatchObject({ code: "crypto" });
  });

  it("still opens a v1 envelope, and tells the two apart", async () => {
    const aad = aadFor("google_account", "email_enc", 1);
    const v1 = await seal(KEY, "owner@example.test", aad);
    const v2 = await sealShort(KEY, "owner@example.test", aad);

    expect(isUnpadded(v1)).toBe(true);
    expect(isUnpadded(v2)).toBe(false);
    expect(isSealed(v1) && isSealed(v2)).toBe(true);
    expect(await open(KEY, v1, aad)).toBe("owner@example.test");
    expect(await open(KEY, v2, aad)).toBe("owner@example.test");
  });
});
