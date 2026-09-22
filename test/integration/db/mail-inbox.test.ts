import { beforeEach, describe, expect, it } from "vitest";

import { rawColumn, resetDb, testRepos } from "./helpers.ts";

beforeEach(resetDb);

const OTP_TTL_SECONDS = 600;

describe("mailInbox.insert", () => {
  it("seals an otp code and never stores it as plaintext", async () => {
    const repos = testRepos();

    const entry = await repos.mailInbox.insert({
      fromAddr: "noreply@mychart.example.org",
      subject: "Your MyChart security code",
      kind: "otp",
      code: "482913",
      url: null,
      receivedAt: 1000,
      expiresAt: 1000 + OTP_TTL_SECONDS,
      rawSize: 512,
    });

    expect(entry.kind).toBe("otp");
    // insert() hands the plaintext straight back for the caller that just
    // stored it, so the SPA that hits POST /api/mail/test still gets a
    // meaningful response -- but listRecent must never do the same for 'otp'.
    const raw = await rawColumn("mail_inbox", "code_enc", "id = ?", entry.id);
    expect(raw).not.toBeNull();
    expect(raw?.startsWith("v1:")).toBe(true);
    expect(raw).not.toContain("482913");
  });

  it("stores a forward_verify code and url together, sealed as one column", async () => {
    const repos = testRepos();

    const entry = await repos.mailInbox.insert({
      fromAddr: "forwarding-noreply@google.com",
      subject: "Gmail Forwarding Confirmation",
      kind: "forward_verify",
      code: "123456789",
      url: "https://mail-settings.google.com/mail/vf-abc",
      receivedAt: 1000,
      expiresAt: null,
      rawSize: 700,
    });

    expect(entry.pendingCode).toBe("123456789");
    expect(entry.pendingUrl).toBe("https://mail-settings.google.com/mail/vf-abc");
    const raw = await rawColumn("mail_inbox", "code_enc", "id = ?", entry.id);
    expect(raw).not.toContain("123456789");
    expect(raw).not.toContain("mail-settings");
  });

  it("stores no code at all for 'other', matching the table's CHECK constraint", async () => {
    const repos = testRepos();

    const entry = await repos.mailInbox.insert({
      fromAddr: "noreply@mychart.example.org",
      subject: "Your appointment reminder",
      kind: "other",
      code: null,
      url: null,
      receivedAt: 1000,
      expiresAt: null,
      rawSize: 300,
    });

    expect(entry.pendingCode).toBeNull();
    expect(await rawColumn("mail_inbox", "code_enc", "id = ?", entry.id)).toBeNull();
  });
});

describe("mailInbox.takeFreshOtp", () => {
  it("claims the newest unconsumed, unexpired otp and marks it consumed", async () => {
    const repos = testRepos();
    await repos.mailInbox.insert({
      fromAddr: "noreply@mychart.example.org",
      subject: "code",
      kind: "otp",
      code: "111111",
      url: null,
      receivedAt: 1000,
      expiresAt: 1000 + OTP_TTL_SECONDS,
      rawSize: 100,
    });
    const newer = await repos.mailInbox.insert({
      fromAddr: "noreply@mychart.example.org",
      subject: "code",
      kind: "otp",
      code: "222222",
      url: null,
      receivedAt: 2000,
      expiresAt: 2000 + OTP_TTL_SECONDS,
      rawSize: 100,
    });

    const claimed = await repos.mailInbox.takeFreshOtp({ since: 500, now: 2100 });

    expect(claimed?.id).toBe(newer.id);
    expect(claimed?.code).toBe("222222");
    expect(await rawColumn("mail_inbox", "consumed_at", "id = ?", newer.id)).not.toBeNull();
  });

  it("never claims a code received before 'since' (the SendCode time)", async () => {
    const repos = testRepos();
    await repos.mailInbox.insert({
      fromAddr: "noreply@mychart.example.org",
      subject: "code",
      kind: "otp",
      code: "111111",
      url: null,
      receivedAt: 1000,
      expiresAt: 1000 + OTP_TTL_SECONDS,
      rawSize: 100,
    });

    expect(await repos.mailInbox.takeFreshOtp({ since: 1500, now: 1600 })).toBeNull();
  });

  it("never claims an otp past its expiry, even if it was never consumed", async () => {
    const repos = testRepos();
    await repos.mailInbox.insert({
      fromAddr: "noreply@mychart.example.org",
      subject: "code",
      kind: "otp",
      code: "111111",
      url: null,
      receivedAt: 1000,
      expiresAt: 1000 + OTP_TTL_SECONDS,
      rawSize: 100,
    });

    const afterExpiry = 1000 + OTP_TTL_SECONDS + 1;
    expect(await repos.mailInbox.takeFreshOtp({ since: 500, now: afterExpiry })).toBeNull();
  });

  it("never claims the same code twice", async () => {
    const repos = testRepos();
    await repos.mailInbox.insert({
      fromAddr: "noreply@mychart.example.org",
      subject: "code",
      kind: "otp",
      code: "111111",
      url: null,
      receivedAt: 1000,
      expiresAt: 1000 + OTP_TTL_SECONDS,
      rawSize: 100,
    });

    const first = await repos.mailInbox.takeFreshOtp({ since: 500, now: 1100 });
    const second = await repos.mailInbox.takeFreshOtp({ since: 500, now: 1200 });

    expect(first?.code).toBe("111111");
    expect(second).toBeNull();
  });

  it("lets exactly one of two concurrent callers claim the code", async () => {
    // The security-relevant guarantee: two sign-in attempts (or a retried one
    // racing the original) can never both act on the same one-time code.
    const repos = testRepos();
    await repos.mailInbox.insert({
      fromAddr: "noreply@mychart.example.org",
      subject: "code",
      kind: "otp",
      code: "111111",
      url: null,
      receivedAt: 1000,
      expiresAt: 1000 + OTP_TTL_SECONDS,
      rawSize: 100,
    });

    const results = await Promise.all([
      repos.mailInbox.takeFreshOtp({ since: 500, now: 1100 }),
      repos.mailInbox.takeFreshOtp({ since: 500, now: 1100 }),
    ]);

    const claimed = results.filter((result) => result !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.code).toBe("111111");
  });

  it("ignores a 'forward_verify' or 'other' row even if it were somehow expired the same way", async () => {
    const repos = testRepos();
    await repos.mailInbox.insert({
      fromAddr: "forwarding-noreply@google.com",
      subject: "Gmail Forwarding Confirmation",
      kind: "forward_verify",
      code: "123456789",
      url: "https://mail-settings.google.com/mail/vf-abc",
      receivedAt: 1000,
      expiresAt: null,
      rawSize: 100,
    });

    expect(await repos.mailInbox.takeFreshOtp({ since: 500, now: 1100 })).toBeNull();
  });
});

describe("mailInbox.listRecent", () => {
  it("never returns an otp row's code, even though it opens forward_verify's", async () => {
    const repos = testRepos();
    await repos.mailInbox.insert({
      fromAddr: "noreply@mychart.example.org",
      subject: "code",
      kind: "otp",
      code: "111111",
      url: null,
      receivedAt: 1000,
      expiresAt: 1000 + OTP_TTL_SECONDS,
      rawSize: 100,
    });
    await repos.mailInbox.insert({
      fromAddr: "forwarding-noreply@google.com",
      subject: "Gmail Forwarding Confirmation",
      kind: "forward_verify",
      code: "123456789",
      url: "https://mail-settings.google.com/mail/vf-abc",
      receivedAt: 2000,
      expiresAt: null,
      rawSize: 100,
    });

    const entries = await repos.mailInbox.listRecent(10);

    expect(entries).toHaveLength(2);
    const otp = entries.find((entry) => entry.kind === "otp");
    const forwardVerify = entries.find((entry) => entry.kind === "forward_verify");
    expect(otp?.pendingCode).toBeNull();
    expect(forwardVerify?.pendingCode).toBe("123456789");
    expect(forwardVerify?.pendingUrl).toBe("https://mail-settings.google.com/mail/vf-abc");
  });

  it("orders newest first and honours the limit", async () => {
    const repos = testRepos();
    for (const receivedAt of [1000, 2000, 3000]) {
      await repos.mailInbox.insert({
        fromAddr: "noreply@mychart.example.org",
        subject: "s",
        kind: "other",
        code: null,
        url: null,
        receivedAt,
        expiresAt: null,
        rawSize: 10,
      });
    }

    const entries = await repos.mailInbox.listRecent(2);

    expect(entries.map((entry) => entry.receivedAt)).toEqual([3000, 2000]);
  });
});

describe("mailInbox.purgeExpired", () => {
  it("drops rows past their expiry and leaves rows with no expiry alone", async () => {
    const repos = testRepos();
    const expired = await repos.mailInbox.insert({
      fromAddr: "noreply@mychart.example.org",
      subject: "code",
      kind: "otp",
      code: "111111",
      url: null,
      receivedAt: 1000,
      expiresAt: 1000 + OTP_TTL_SECONDS,
      rawSize: 100,
    });
    const noTtl = await repos.mailInbox.insert({
      fromAddr: "noreply@mychart.example.org",
      subject: "other",
      kind: "other",
      code: null,
      url: null,
      receivedAt: 1000,
      expiresAt: null,
      rawSize: 50,
    });

    const removed = await repos.mailInbox.purgeExpired(1000 + OTP_TTL_SECONDS + 1);

    expect(removed).toBe(1);
    const remaining = await repos.mailInbox.listRecent(10);
    expect(remaining.map((entry) => entry.id)).toEqual([noTtl.id]);
    expect(remaining.map((entry) => entry.id)).not.toContain(expired.id);
  });
});
