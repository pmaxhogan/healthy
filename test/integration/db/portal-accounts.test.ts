// Real workerd, real D1, real WebCrypto. What this file is actually for is the
// sealing: that a credential and a cookie jar are unreadable in the row, that the
// AAD binds each one to its own column on its own provider, and that the CHECK in
// migrations/0002_portal.sql is never the thing the owner sees.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { aadFor, open } from "../../../worker/db/crypto.ts";
import { utcDay } from "../../../worker/db/repos/portal-accounts.ts";
import { DAY_SECONDS } from "../../../worker/lib/time.ts";

import {
  OTHER_DATA_KEY,
  T0,
  clock,
  rawColumn,
  resetDb,
  seedProvider,
  testRepos,
} from "./helpers.ts";

import type { AppError } from "../../../worker/lib/errors.ts";

const CREDENTIALS = { username: "portal-login", password: "portal-password" };
const ENDPOINT = { baseUrl: "https://portal.example.test", mountPath: "/MyChart/" };
const MFA_CONTACT = "owner@example.test";
const SEALED_COLUMNS = ["username_enc", "password_enc", "cookie_jar_enc", "mfa_contact_enc"];

beforeEach(resetDb);

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as AppError).code;
  }
  throw new Error("expected the promise to reject");
}

describe("portalAccounts.setCredentials", () => {
  it("creates the row and seals both credential columns", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);

    const row = await repos.portalAccounts.setCredentials(providerId, CREDENTIALS);

    expect(row.provider_id).toBe(providerId);
    expect(row.session_state).toBe("none");
    await expect(repos.portalAccounts.getSecrets(providerId)).resolves.toStrictEqual({
      username: CREDENTIALS.username,
      password: CREDENTIALS.password,
      cookieJar: null,
      mfaContact: null,
    });

    for (const column of ["username_enc", "password_enc"]) {
      const raw = await rawColumn("portal_accounts", column, "provider_id = ?", providerId);

      expect(raw?.startsWith("v1:"), column).toBe(true);
      expect(raw, column).not.toContain("portal-");
    }
  });

  it("stores the endpoint when it is supplied with the credentials", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);

    const row = await repos.portalAccounts.setCredentials(providerId, {
      ...CREDENTIALS,
      ...ENDPOINT,
    });

    expect(row.base_url).toBe(ENDPOINT.baseUrl);
    expect(row.mount_path).toBe(ENDPOINT.mountPath);
  });

  it("drops the cookie jar and the session state when the credentials change", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    await repos.portalAccounts.setCredentials(providerId, { ...CREDENTIALS, ...ENDPOINT });
    await repos.portalAccounts.saveCookieJar(providerId, '{"v":1,"cookies":[]}');
    await repos.portalAccounts.markActive(providerId);

    const row = await repos.portalAccounts.setCredentials(providerId, {
      username: "new-login",
      password: "new-password",
    });

    // A new password invalidates whatever the old session was.
    expect(row.cookie_jar_enc).toBeNull();
    expect(row.session_state).toBe("none");
  });

  it("reuses the one row, because provider_id is the primary key", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);

    await repos.portalAccounts.setCredentials(providerId, CREDENTIALS);
    await repos.portalAccounts.setCredentials(providerId, { username: "b", password: "c" });

    expect(await repos.portalAccounts.list()).toHaveLength(1);
    await expect(repos.portalAccounts.getSecrets(providerId)).resolves.toMatchObject({
      username: "b",
    });
  });

  it("seals the MFA contact when supplied, and leaves it alone when omitted", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);

    await repos.portalAccounts.setCredentials(providerId, {
      ...CREDENTIALS,
      mfaContact: MFA_CONTACT,
    });

    await expect(repos.portalAccounts.getSecrets(providerId)).resolves.toMatchObject({
      mfaContact: MFA_CONTACT,
    });
    await expect(repos.portalAccounts.dto(providerId)).resolves.toMatchObject({
      hasMfaContact: true,
    });
    const raw = await rawColumn(
      "portal_accounts",
      "mfa_contact_enc",
      "provider_id = ?",
      providerId,
    );
    expect(raw?.startsWith("v1:")).toBe(true);
    expect(raw).not.toContain("owner");

    // A later credential change with no `mfaContact` leaves the stored value be --
    // a password rotation is not a reason to forget where the codes go.
    await repos.portalAccounts.setCredentials(providerId, { username: "b", password: "c" });

    await expect(repos.portalAccounts.getSecrets(providerId)).resolves.toMatchObject({
      mfaContact: MFA_CONTACT,
    });
  });
});

describe("portalAccounts sealing", () => {
  it("cannot be opened with a different DATA_KEY", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    await repos.portalAccounts.setCredentials(providerId, CREDENTIALS);

    const other = testRepos({ dataKey: OTHER_DATA_KEY });

    await expect(codeOf(other.portalAccounts.getSecrets(providerId))).resolves.toBe("crypto");
  });

  it("binds every sealed column to its own column name", async () => {
    // A key this test holds, so it can try to open the columns by hand: the
    // helper's own key is deliberately not exported.
    const dataKey = OTHER_DATA_KEY;
    const repos = testRepos({ dataKey });
    const providerId = await seedProvider(repos);
    await repos.portalAccounts.setCredentials(providerId, {
      ...CREDENTIALS,
      mfaContact: MFA_CONTACT,
    });
    await repos.portalAccounts.saveCookieJar(providerId, '{"v":1,"cookies":[]}');

    for (const column of SEALED_COLUMNS) {
      const sealed = await rawColumn("portal_accounts", column, "provider_id = ?", providerId);
      expect(sealed, column).not.toBeNull();
      // Its own AAD opens it...
      await expect(
        open(dataKey, sealed ?? "", aadFor("portal_accounts", column, providerId)),
      ).resolves.toBeTypeOf("string");
      // ...and a sibling column's does not.
      const siblings = SEALED_COLUMNS.filter((name) => name !== column);
      for (const wrong of siblings) {
        await expect(
          open(dataKey, sealed ?? "", aadFor("portal_accounts", wrong, providerId)),
        ).rejects.toThrow();
      }
    }
  });

  it("refuses a ciphertext moved to another provider's row", async () => {
    const repos = testRepos();
    const mine = await seedProvider(repos, { displayName: "Example One" });
    const theirs = await seedProvider(repos, { displayName: "Example Two" });
    await repos.portalAccounts.setCredentials(mine, CREDENTIALS);
    await repos.portalAccounts.setCredentials(theirs, { username: "u", password: "p" });

    const stolen = await rawColumn("portal_accounts", "password_enc", "provider_id = ?", mine);
    await env.DB.prepare("UPDATE portal_accounts SET password_enc = ? WHERE provider_id = ?")
      .bind(stolen, theirs)
      .run();

    // The AAD carries the provider id, so the copy is inert rather than usable.
    await expect(codeOf(repos.portalAccounts.getSecrets(theirs))).resolves.toBe("crypto");
  });

  it("seals the cookie jar and forgets it on null", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    const jar = '{"v":1,"cookies":[{"name":"MCSession","value":"secret-session-value"}]}';

    await repos.portalAccounts.saveCookieJar(providerId, jar);

    const raw = await rawColumn("portal_accounts", "cookie_jar_enc", "provider_id = ?", providerId);
    expect(raw).not.toContain("secret-session-value");
    await expect(repos.portalAccounts.getSecrets(providerId)).resolves.toMatchObject({
      cookieJar: jar,
    });

    await repos.portalAccounts.saveCookieJar(providerId, null);

    await expect(repos.portalAccounts.getSecrets(providerId)).resolves.toMatchObject({
      cookieJar: null,
    });
  });

  it("returns null secrets for a provider with no portal account", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);

    await expect(repos.portalAccounts.getSecrets(providerId)).resolves.toBeNull();
  });
});

describe("portalAccounts state machine", () => {
  it("refuses to go active before the endpoint is known", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    await repos.portalAccounts.setCredentials(providerId, CREDENTIALS);

    // The migration's CHECK would also refuse this; the repo refuses it first so
    // the owner gets a code instead of a constraint violation.
    await expect(codeOf(repos.portalAccounts.markActive(providerId))).resolves.toBe("conflict");
  });

  it("goes active once the endpoint has been recorded, clearing the error", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const providerId = await seedProvider(repos);
    await repos.portalAccounts.setCredentials(providerId, CREDENTIALS);
    await repos.portalAccounts.markNeedsReauth(providerId, "portal_2fa_rejected");

    await repos.portalAccounts.setEndpoint(providerId, ENDPOINT);
    time.advance(60);
    await repos.portalAccounts.markActive(providerId);

    const row = await repos.portalAccounts.get(providerId);
    expect(row?.session_state).toBe("active");
    expect(row?.last_ok_at).toBe(T0 + 60);
    expect(row?.last_error_code).toBeNull();
    expect(row?.needs_reauth_since).toBeNull();
  });

  it("stamps needs_reauth_since once and leaves it alone on a later failure", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const providerId = await seedProvider(repos);
    await repos.portalAccounts.setCredentials(providerId, CREDENTIALS);

    await repos.portalAccounts.markNeedsReauth(providerId, "portal_login_failed");
    time.advance(3600);
    await repos.portalAccounts.markNeedsReauth(providerId, "portal_2fa_rejected");

    const row = await repos.portalAccounts.get(providerId);
    // The reconnect card's age has to reflect how long it has been ignored.
    expect(row?.needs_reauth_since).toBe(T0);
    expect(row?.last_error_code).toBe("portal_2fa_rejected");
    expect(row?.session_state).toBe("needs_reauth");
  });

  it("reports not_found rather than creating a row for an unknown provider", async () => {
    const repos = testRepos();

    await expect(codeOf(repos.portalAccounts.markActive("nope"))).resolves.toBe("not_found");
  });

  it("listActive returns only active accounts on live providers", async () => {
    const repos = testRepos();
    const active = await seedProvider(repos, { displayName: "Example Active" });
    const idle = await seedProvider(repos, { displayName: "Example Idle" });
    const deleted = await seedProvider(repos, { displayName: "Example Deleted" });
    for (const id of [active, idle, deleted]) {
      await repos.portalAccounts.setCredentials(id, { ...CREDENTIALS, ...ENDPOINT });
    }
    await repos.portalAccounts.markActive(active);
    await repos.portalAccounts.markActive(deleted);
    await repos.providers.softDelete(deleted);

    const rows = await repos.portalAccounts.listActive();

    expect(rows.map((row) => row.provider_id)).toStrictEqual([active]);
  });

  it("goes away with the provider it belongs to", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    await repos.portalAccounts.setCredentials(providerId, CREDENTIALS);

    await env.DB.prepare("DELETE FROM providers WHERE id = ?").bind(providerId).run();

    expect(await repos.portalAccounts.list()).toHaveLength(0);
  });
});

describe("portalAccounts login attempts", () => {
  it("counts attempts within one UTC day", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);

    await expect(repos.portalAccounts.recordLoginAttempt(providerId)).resolves.toBe(1);
    await expect(repos.portalAccounts.recordLoginAttempt(providerId)).resolves.toBe(2);
    await expect(repos.portalAccounts.countLoginAttemptsToday(providerId)).resolves.toBe(2);
  });

  it("resets on its own once the stored day is no longer today", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const providerId = await seedProvider(repos);
    await repos.portalAccounts.recordLoginAttempt(providerId);
    await repos.portalAccounts.recordLoginAttempt(providerId);

    time.advance(DAY_SECONDS);

    // No sweeper ran: the stored day simply stopped matching.
    await expect(repos.portalAccounts.countLoginAttemptsToday(providerId)).resolves.toBe(0);
    await expect(repos.portalAccounts.recordLoginAttempt(providerId)).resolves.toBe(1);
    const row = await repos.portalAccounts.get(providerId);
    expect(row?.login_attempts_day).toBe(utcDay(T0 + DAY_SECONDS));
  });

  it("stamps last_login_at, which is what the hourly limit reads", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const providerId = await seedProvider(repos);

    time.advance(900);
    await repos.portalAccounts.recordLoginAttempt(providerId);

    const row = await repos.portalAccounts.get(providerId);
    expect(row?.last_login_at).toBe(T0 + 900);
  });

  it("is zero for a provider that has never tried", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);

    await expect(repos.portalAccounts.countLoginAttemptsToday(providerId)).resolves.toBe(0);
  });
});

describe("portalAccounts.dto", () => {
  it("says whether there are credentials and a session without revealing either", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    await repos.portalAccounts.setCredentials(providerId, {
      ...CREDENTIALS,
      ...ENDPOINT,
      mfaContact: MFA_CONTACT,
    });
    await repos.portalAccounts.saveCookieJar(providerId, '{"v":1,"cookies":[]}');
    await repos.portalAccounts.markActive(providerId);
    await repos.portalAccounts.recordLoginAttempt(providerId);

    const dto = await repos.portalAccounts.dto(providerId);

    expect(dto).toStrictEqual({
      providerId,
      baseUrl: ENDPOINT.baseUrl,
      mountPath: ENDPOINT.mountPath,
      hasCredentials: true,
      hasSession: true,
      hasMfaContact: true,
      hasOtpSender: false,
      state: "active",
      lastLoginAt: "2026-01-01T00:00:00.000Z",
      lastOkAt: "2026-01-01T00:00:00.000Z",
      lastErrorCode: null,
      needsReauthSince: null,
      loginAttemptsToday: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(JSON.stringify(dto)).not.toContain("portal-password");
    expect(JSON.stringify(dto)).not.toContain(MFA_CONTACT);
  });

  it("seals the expected OTP sender when supplied, and reports only that it exists", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);

    await repos.portalAccounts.setCredentials(providerId, {
      ...CREDENTIALS,
      otpSenderDomain: "Mail.Portal.Example.ORG",
    });

    // Normalised on the way in: it is compared against a domain read out of a
    // `From:` header, which may arrive in any case.
    await expect(repos.portalAccounts.getOtpSender(providerId)).resolves.toBe(
      "mail.portal.example.org",
    );
    await expect(repos.portalAccounts.dto(providerId)).resolves.toMatchObject({
      hasOtpSender: true,
    });
    const raw = await rawColumn("portal_accounts", "otp_sender_enc", "provider_id = ?", providerId);
    expect(raw?.startsWith("v1:")).toBe(true);
    // A sending domain names the health system, so it is sealed like the rest.
    expect(raw).not.toContain("portal.example.org");
    // Never in the DTO: the UI learns that the binding exists, not what it is.
    expect(JSON.stringify(await repos.portalAccounts.dto(providerId))).not.toContain(
      "mail.portal.example.org",
    );
  });

  it("learns the expected OTP sender once, and never overwrites a stored one", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    await repos.portalAccounts.setCredentials(providerId, CREDENTIALS);

    // Nothing stored yet, so the first accepted code's sender is recorded.
    await expect(repos.portalAccounts.learnOtpSender(providerId, "Mail.Example.ORG")).resolves.toBe(
      true,
    );
    await expect(repos.portalAccounts.getOtpSender(providerId)).resolves.toBe("mail.example.org");

    // A later success from somewhere else must not re-bind the account: that
    // would undo the binding one accepted code at a time.
    await expect(
      repos.portalAccounts.learnOtpSender(providerId, "other.example.net"),
    ).resolves.toBe(false);
    await expect(repos.portalAccounts.getOtpSender(providerId)).resolves.toBe("mail.example.org");
  });

  it("learns nothing from a blank sender", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);
    await repos.portalAccounts.setCredentials(providerId, CREDENTIALS);

    await expect(repos.portalAccounts.learnOtpSender(providerId, " ".repeat(3))).resolves.toBe(
      false,
    );
    await expect(repos.portalAccounts.getOtpSender(providerId)).resolves.toBeNull();
  });

  it("reports yesterday's attempt count as zero", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const providerId = await seedProvider(repos);
    await repos.portalAccounts.recordLoginAttempt(providerId);

    time.advance(DAY_SECONDS);

    await expect(repos.portalAccounts.dto(providerId)).resolves.toMatchObject({
      loginAttemptsToday: 0,
    });
  });

  it("is null for a provider with no portal account", async () => {
    const repos = testRepos();
    const providerId = await seedProvider(repos);

    await expect(repos.portalAccounts.dto(providerId)).resolves.toBeNull();
  });
});
