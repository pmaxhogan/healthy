// The one thing this script can get wrong silently is the AAD: a value sealed
// under the wrong one is written successfully, read back successfully, and then
// fails to open inside the Worker at sign-in time, with a `crypto` error that
// says nothing about why. So the AADs are pinned against `aadFor` directly, the
// same way `set-health_system-secret.test.ts` pins its one.

import { describe, expect, it } from "vitest";

import {
  parseArgs,
  portalMfaContactAad,
  portalOtpSenderAad,
  portalPasswordAad,
  portalUsernameAad,
  sealPortalCredentials,
  splitStdin,
} from "../../scripts/set-portal-credentials.ts";
import { aadFor, open } from "../../worker/db/crypto.ts";

// Synthetic ULIDs -- not real health system ids -- just something that satisfies
// worker/lib/ids.ts's ID_PATTERN shape.
const HEALTH_SYSTEM_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_HEALTH_SYSTEM_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const CREDENTIALS = { username: "portal-login", password: "portal-password" };

function freshKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
}

describe("portal credential AADs", () => {
  it("match the AADs worker/db/repos/portal-accounts.ts seals under", () => {
    expect(portalUsernameAad(HEALTH_SYSTEM_ID)).toBe(
      aadFor("portal_accounts", "username_enc", HEALTH_SYSTEM_ID),
    );
    expect(portalPasswordAad(HEALTH_SYSTEM_ID)).toBe(
      aadFor("portal_accounts", "password_enc", HEALTH_SYSTEM_ID),
    );
    expect(portalUsernameAad(HEALTH_SYSTEM_ID)).toBe(
      `portal_accounts.username_enc.${HEALTH_SYSTEM_ID}`,
    );
    expect(portalOtpSenderAad(HEALTH_SYSTEM_ID)).toBe(
      aadFor("portal_accounts", "otp_sender_enc", HEALTH_SYSTEM_ID),
    );
    expect(portalMfaContactAad(HEALTH_SYSTEM_ID)).toBe(
      aadFor("portal_accounts", "mfa_contact_enc", HEALTH_SYSTEM_ID),
    );
  });

  it("differ between the columns, so none opens another", () => {
    expect(portalUsernameAad(HEALTH_SYSTEM_ID)).not.toBe(portalPasswordAad(HEALTH_SYSTEM_ID));
    expect(portalUsernameAad(HEALTH_SYSTEM_ID)).not.toBe(portalMfaContactAad(HEALTH_SYSTEM_ID));
    expect(portalPasswordAad(HEALTH_SYSTEM_ID)).not.toBe(portalMfaContactAad(HEALTH_SYSTEM_ID));
    expect(portalOtpSenderAad(HEALTH_SYSTEM_ID)).not.toBe(portalMfaContactAad(HEALTH_SYSTEM_ID));
    expect(portalOtpSenderAad(HEALTH_SYSTEM_ID)).not.toBe(portalPasswordAad(HEALTH_SYSTEM_ID));
  });
});

describe("sealPortalCredentials", () => {
  it("round-trips both values through the Worker's own open()", async () => {
    const dataKey = freshKey();

    const sealed = await sealPortalCredentials(dataKey, HEALTH_SYSTEM_ID, CREDENTIALS);

    expect(sealed.username.startsWith("v2:")).toBe(true);
    expect(sealed.password.startsWith("v2:")).toBe(true);
    expect(`${sealed.username}${sealed.password}`).not.toContain("portal-");
    await expect(open(dataKey, sealed.username, portalUsernameAad(HEALTH_SYSTEM_ID))).resolves.toBe(
      CREDENTIALS.username,
    );
    await expect(open(dataKey, sealed.password, portalPasswordAad(HEALTH_SYSTEM_ID))).resolves.toBe(
      CREDENTIALS.password,
    );
  });

  it("will not let the password open under the username's AAD", async () => {
    const dataKey = freshKey();
    const sealed = await sealPortalCredentials(dataKey, HEALTH_SYSTEM_ID, CREDENTIALS);

    await expect(
      open(dataKey, sealed.password, portalUsernameAad(HEALTH_SYSTEM_ID)),
    ).rejects.toMatchObject({ code: "crypto" });
  });

  it("will not let a value open on another health system's row", async () => {
    const dataKey = freshKey();
    const sealed = await sealPortalCredentials(dataKey, HEALTH_SYSTEM_ID, CREDENTIALS);

    await expect(
      open(dataKey, sealed.password, portalPasswordAad(OTHER_HEALTH_SYSTEM_ID)),
    ).rejects.toMatchObject({ code: "crypto" });
  });

  it("never seals the same password to the same ciphertext twice", async () => {
    const dataKey = freshKey();
    const [first, second] = await Promise.all([
      sealPortalCredentials(dataKey, HEALTH_SYSTEM_ID, CREDENTIALS),
      sealPortalCredentials(dataKey, HEALTH_SYSTEM_ID, CREDENTIALS),
    ]);

    expect(first.password).not.toBe(second.password);
  });
});

describe("splitStdin", () => {
  it("takes the first line as the username and the rest as the password", () => {
    expect(splitStdin("owner-login\nowner-password\n")).toStrictEqual({
      username: "owner-login",
      password: "owner-password",
    });
  });

  it("tolerates CRLF, which is what a Windows pipe produces", () => {
    expect(splitStdin("owner-login\r\nowner-password\r\n")).toStrictEqual({
      username: "owner-login",
      password: "owner-password",
    });
  });

  it("keeps whitespace inside a password, stripping only the trailing newline", () => {
    // Trimming a password would turn a copy/paste mistake into an unexplainable
    // sign-in failure, so only the newline the shell added comes off.
    expect(splitStdin("owner-login\n  pass word  \n").password).toBe("  pass word  ");
  });

  it("refuses input with no newline at all, rather than guessing", () => {
    expect(() => splitStdin("just-one-value")).toThrow(/username line/);
  });
});

describe("parseArgs", () => {
  it("accepts --health-system with --remote or --local", () => {
    expect(parseArgs(["--health-system", HEALTH_SYSTEM_ID, "--remote"])).toEqual({
      healthSystemId: HEALTH_SYSTEM_ID,
      target: "--remote",
      mfaContact: false,
      otpSender: false,
    });
    expect(parseArgs(["--health-system", HEALTH_SYSTEM_ID, "--local"])).toEqual({
      healthSystemId: HEALTH_SYSTEM_ID,
      target: "--local",
      mfaContact: false,
      otpSender: false,
    });
  });

  it("sets mfaContact when --mfa-contact is given", () => {
    expect(parseArgs(["--health-system", HEALTH_SYSTEM_ID, "--remote", "--mfa-contact"])).toEqual({
      healthSystemId: HEALTH_SYSTEM_ID,
      target: "--remote",
      mfaContact: true,
      otpSender: false,
    });
  });

  it("sets otpSender when --otp-sender is given", () => {
    expect(parseArgs(["--health-system", HEALTH_SYSTEM_ID, "--remote", "--otp-sender"])).toEqual({
      healthSystemId: HEALTH_SYSTEM_ID,
      target: "--remote",
      mfaContact: false,
      otpSender: true,
    });
  });

  it("refuses when --health-system is missing", () => {
    expect(() => parseArgs(["--remote"])).toThrow(/--health-system is required/);
  });

  it("refuses when neither, or both, of --remote and --local are given", () => {
    expect(() => parseArgs(["--health-system", HEALTH_SYSTEM_ID])).toThrow(
      /exactly one of --remote or --local/,
    );
    expect(() => parseArgs(["--health-system", HEALTH_SYSTEM_ID, "--remote", "--local"])).toThrow(
      /exactly one of --remote or --local/,
    );
  });

  it("refuses an unrecognized argument and a valueless --health-system", () => {
    expect(() => parseArgs(["--health-system", HEALTH_SYSTEM_ID, "--remote", "--bogus"])).toThrow(
      /unrecognized argument: --bogus/,
    );
    expect(() => parseArgs(["--health-system", "--remote"])).toThrow(
      /--health-system requires a value/,
    );
  });
});
