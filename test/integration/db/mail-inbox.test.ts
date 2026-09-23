// `mail_inbox`, in real workerd against real D1.
//
// Three things here matter more than the CRUD around them.
//
// **Nothing about a message is stored in plaintext.** The code, the sender and
// the subject are all sealed; the legacy `from_addr`/`subject` columns 0005 left
// in place are written empty.
//
// **A claim is bound to a sender.** `takeFreshOtp` takes the expected sender for
// the provider that asked for the code, and only that sender's rows are
// eligible; without one, the sender allowlist stands in, narrowed to a sender on
// the same site as the portal's own host -- so a second configured portal's own
// allowlisted sender is not eligible either. Oldest eligible row first, so a
// flood of later messages cannot outrun the portal's own.
//
// **A code can never be claimed twice**, including by two concurrent callers.
//
// Every sender and body below is synthetic, per CLAUDE.md: RFC 2606 domains.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { rawColumn, resetDb, testRepos } from "./helpers.ts";

beforeEach(resetDb);

const OTP_TTL_SECONDS = 600;
const OTHER_TTL_SECONDS = 24 * 60 * 60;
const SEVEN_DAYS = 7 * 24 * 60 * 60;

/** The sender every OTP fixture below comes from, and the allowlist that admits it. */
const PORTAL_SENDER = "noreply@portal.example.org";
const ALLOWLIST = ["portal.example.org", "google.com"];
/** This suite's one portal's own host, sharing a registrable domain with `PORTAL_SENDER`. */
const PORTAL_HOST = "portal.example.org";

/**
 * The filter a first-ever sign-in passes: no expected sender yet, the allowlist
 * plus this portal's own host. `portalHost` defaults to `PORTAL_HOST` -- the
 * multi-portal tests below pass their own.
 */
function unbound(since: number, now: number, portalHost: string | null = PORTAL_HOST) {
  return { since, now, expectedSender: null, allowlist: ALLOWLIST, portalHost };
}

/** The filter a provider that already knows its sender passes. `portalHost` is unused here. */
function boundTo(expectedSender: string, since: number, now: number) {
  return { since, now, expectedSender, allowlist: ALLOWLIST, portalHost: null };
}

/**
 * A pre-0005 row: plaintext sender, no TTL at all.
 *
 * The one shape the repo can no longer write, and exactly what the purge's age
 * ceiling and the sealed-column fallbacks exist for.
 */
async function seedLegacyRowWithoutTtl(id: string, receivedAt: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO mail_inbox (id, received_at, from_addr, subject, kind, expires_at, raw_size)
     VALUES (?, ?, ?, ?, 'other', NULL, 10)`,
  )
    .bind(id, receivedAt, PORTAL_SENDER, "legacy")
    .run();
}

/** One 'otp' row from `fromAddr`, with a 10-minute TTL from `receivedAt`. */
async function seedOtp(
  code: string,
  receivedAt: number,
  fromAddr: string = PORTAL_SENDER,
): Promise<{ id: string }> {
  return testRepos().mailInbox.insert({
    fromAddr,
    subject: "code",
    kind: "otp",
    code,
    url: null,
    receivedAt,
    expiresAt: receivedAt + OTP_TTL_SECONDS,
    rawSize: 100,
  });
}

describe("mailInbox.insert", () => {
  it("seals an otp code and never stores it as plaintext", async () => {
    const repos = testRepos();

    const entry = await repos.mailInbox.insert({
      fromAddr: PORTAL_SENDER,
      subject: "Your portal security code",
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

  it("seals the sender and the subject, writing the legacy plaintext columns empty", async () => {
    const repos = testRepos();

    const entry = await repos.mailInbox.insert({
      fromAddr: PORTAL_SENDER,
      subject: "Your portal security code",
      kind: "otp",
      code: "482913",
      url: null,
      receivedAt: 1000,
      expiresAt: 1000 + OTP_TTL_SECONDS,
      rawSize: 512,
    });

    const sealedFrom = await rawColumn("mail_inbox", "from_addr_enc", "id = ?", entry.id);
    const sealedSubject = await rawColumn("mail_inbox", "subject_enc", "id = ?", entry.id);
    expect(sealedFrom?.startsWith("v1:")).toBe(true);
    expect(sealedFrom).not.toContain("portal.example.org");
    expect(sealedSubject?.startsWith("v1:")).toBe(true);
    expect(sealedSubject).not.toContain("security code");

    // 0005 keeps the two old columns (from_addr is NOT NULL) and writes them
    // empty, so nothing about the message is legible without DATA_KEY.
    expect(await rawColumn("mail_inbox", "from_addr", "id = ?", entry.id)).toBe("");
    expect(await rawColumn("mail_inbox", "subject", "id = ?", entry.id)).toBe("");
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
      expiresAt: 1000 + OTHER_TTL_SECONDS,
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
      fromAddr: PORTAL_SENDER,
      subject: "Your appointment reminder",
      kind: "other",
      code: null,
      url: null,
      receivedAt: 1000,
      expiresAt: 1000 + OTHER_TTL_SECONDS,
      rawSize: 300,
    });

    expect(entry.pendingCode).toBeNull();
    expect(await rawColumn("mail_inbox", "code_enc", "id = ?", entry.id)).toBeNull();
  });
});

describe("mailInbox.takeFreshOtp", () => {
  it("claims the OLDEST eligible unconsumed, unexpired otp and marks it consumed", async () => {
    // Oldest, not newest: the portal's own code is the one that arrived closest
    // behind SendCode, and preferring the newest handed every poll to whoever
    // was sending fastest.
    const repos = testRepos();
    const oldest = await seedOtp("111111", 1000);
    await seedOtp("222222", 1200);

    const claimed = await repos.mailInbox.takeFreshOtp(unbound(500, 1300));

    expect(claimed?.id).toBe(oldest.id);
    expect(claimed?.code).toBe("111111");
    expect(claimed?.senderDomain).toBe("portal.example.org");
    expect(await rawColumn("mail_inbox", "consumed_at", "id = ?", oldest.id)).not.toBeNull();
  });

  it("never claims a code received before 'since' (the SendCode time)", async () => {
    const repos = testRepos();
    await seedOtp("111111", 1000);

    expect(await repos.mailInbox.takeFreshOtp(unbound(1500, 1600))).toBeNull();
  });

  it("never claims an otp past its expiry, even if it was never consumed", async () => {
    const repos = testRepos();
    await seedOtp("111111", 1000);

    const afterExpiry = 1000 + OTP_TTL_SECONDS + 1;
    expect(await repos.mailInbox.takeFreshOtp(unbound(500, afterExpiry))).toBeNull();
  });

  it("never claims the same code twice", async () => {
    const repos = testRepos();
    await seedOtp("111111", 1000);

    const first = await repos.mailInbox.takeFreshOtp(unbound(500, 1100));
    const second = await repos.mailInbox.takeFreshOtp(unbound(500, 1200));

    expect(first?.code).toBe("111111");
    expect(second).toBeNull();
  });

  it("lets exactly one of two concurrent callers claim the code", async () => {
    // The security-relevant guarantee: two sign-in attempts (or a retried one
    // racing the original) can never both act on the same one-time code.
    const repos = testRepos();
    await seedOtp("111111", 1000);

    const results = await Promise.all([
      repos.mailInbox.takeFreshOtp(unbound(500, 1100)),
      repos.mailInbox.takeFreshOtp(unbound(500, 1100)),
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
      expiresAt: 1000 + OTHER_TTL_SECONDS,
      rawSize: 100,
    });

    expect(await repos.mailInbox.takeFreshOtp(unbound(500, 1100))).toBeNull();
  });

  it("never claims a row from an unexpected sender when the provider has an expected one", async () => {
    // The binding that makes an OTP claim safe: whoever else can reach the
    // inbound address, their code is not eligible for this account.
    const repos = testRepos();
    await seedOtp("999999", 1000, "attacker@portal.example.org.attacker.example");
    const mine = await seedOtp("111111", 1100);

    const claimed = await repos.mailInbox.takeFreshOtp(boundTo("portal.example.org", 500, 1200));

    expect(claimed?.id).toBe(mine.id);
    expect(claimed?.code).toBe("111111");
  });

  it("claims nothing at all when only an unexpected sender's code is waiting", async () => {
    const repos = testRepos();
    await seedOtp("999999", 1000, "attacker@other.example.net");

    expect(await repos.mailInbox.takeFreshOtp(boundTo("portal.example.org", 500, 1100))).toBeNull();
  });

  it("accepts a subdomain of the expected sender, and nothing that merely contains it", async () => {
    const repos = testRepos();
    const subdomain = await seedOtp("111111", 1000, "noreply@mail.portal.example.org");

    const claimed = await repos.mailInbox.takeFreshOtp(boundTo("portal.example.org", 500, 1100));
    expect(claimed?.id).toBe(subdomain.id);

    await seedOtp("222222", 1200, "noreply@notportal.example.org");
    expect(await repos.mailInbox.takeFreshOtp(boundTo("portal.example.org", 500, 1300))).toBeNull();
  });

  it("falls back to the allowlist when there is no expected sender, anchored at a label", async () => {
    const repos = testRepos();
    await seedOtp("999999", 1000, "attacker@portal.example.org.attacker.example");
    const allowed = await seedOtp("111111", 1100, "noreply@portal.example.org");

    const claimed = await repos.mailInbox.takeFreshOtp(unbound(500, 1200));

    expect(claimed?.id).toBe(allowed.id);
  });

  // The live bug: two portals sharing one mail_sender_allowlist, neither with a
  // learned sender yet. Before this, "on the allowlist" was the whole rule, so
  // whichever portal's code arrived first -- not whichever portal asked for
  // it -- got claimed. `portal-a.example` and `portal-b.example` are distinct
  // registrable domains, exactly like two real health systems' own domains.
  it("does not claim a code from a second configured portal's own domain until this one's sender is learned", async () => {
    const repos = testRepos();
    const allowlist = ["portal-a.example", "portal-b.example"];
    const otherPortalsCode = await seedOtp("999999", 1000, "noreply@portal-b.example");
    const ownCode = await seedOtp("111111", 1100, "noreply@portal-a.example");

    const claimed = await repos.mailInbox.takeFreshOtp({
      since: 500,
      now: 1200,
      expectedSender: null,
      allowlist,
      portalHost: "portal-a.example",
    });

    // The older, allowlisted-but-wrong-portal row is skipped entirely, not
    // merely deprioritised behind the right one.
    expect(claimed?.id).toBe(ownCode.id);
    expect(claimed?.code).toBe("111111");
    expect(await rawColumn("mail_inbox", "consumed_at", "id = ?", otherPortalsCode.id)).toBeNull();
  });

  it("matches a sender on a subdomain of the portal's own registrable domain", async () => {
    const repos = testRepos();
    const claimed = await seedOtp("222222", 1000, "noreply@mail.portal-a.example");

    const result = await repos.mailInbox.takeFreshOtp({
      since: 500,
      now: 1100,
      expectedSender: null,
      allowlist: ["portal-a.example"],
      portalHost: "portal-a.example",
    });

    expect(result?.id).toBe(claimed.id);
  });

  it("still claims by the learned sender even when it is not on the portal's own site", async () => {
    // The learned-sender binding is the stronger rule: a vendor-hosted portal can
    // legitimately email from a different domain than it serves the login page
    // from, and once that sender is learned it must keep working even though it
    // would fail the same-site check the unlearned path applies.
    const repos = testRepos();
    const mine = await seedOtp("333333", 1000, "noreply@vendor-mail.example");

    const result = await repos.mailInbox.takeFreshOtp({
      since: 500,
      now: 1100,
      expectedSender: "vendor-mail.example",
      allowlist: [],
      portalHost: "portal-a.example",
    });

    expect(result?.id).toBe(mine.id);
  });
});

describe("mailInbox.listRecent", () => {
  it("never returns an otp row's code, even though it opens forward_verify's", async () => {
    const repos = testRepos();
    await seedOtp("111111", 1000);
    await repos.mailInbox.insert({
      fromAddr: "forwarding-noreply@google.com",
      subject: "Gmail Forwarding Confirmation",
      kind: "forward_verify",
      code: "123456789",
      url: "https://mail-settings.google.com/mail/vf-abc",
      receivedAt: 2000,
      expiresAt: 2000 + OTHER_TTL_SECONDS,
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

  it("reduces the sealed sender to a domain and keeps a subject only for forward_verify", async () => {
    const repos = testRepos();
    await seedOtp("111111", 1000);
    await repos.mailInbox.insert({
      fromAddr: "forwarding-noreply@google.com",
      subject: "Gmail Forwarding Confirmation",
      kind: "forward_verify",
      code: "123456789",
      url: "https://mail-settings.google.com/mail/vf-abc",
      receivedAt: 2000,
      expiresAt: 2000 + OTHER_TTL_SECONDS,
      rawSize: 100,
    });

    const entries = await repos.mailInbox.listRecent(10);

    const otp = entries.find((entry) => entry.kind === "otp");
    const forwardVerify = entries.find((entry) => entry.kind === "forward_verify");
    // The local part never leaves the repo, for any kind.
    expect(otp?.senderDomain).toBe("portal.example.org");
    expect(forwardVerify?.senderDomain).toBe("google.com");
    // The subject of a portal message is the portal's own wording about the
    // owner's care; only Gmail's confirmation subject is of any use on a screen.
    expect(otp?.subject).toBeNull();
    expect(forwardVerify?.subject).toBe("Gmail Forwarding Confirmation");
  });

  it("orders newest first and honours the limit", async () => {
    const repos = testRepos();
    for (const receivedAt of [1000, 2000, 3000]) {
      await repos.mailInbox.insert({
        fromAddr: PORTAL_SENDER,
        subject: "s",
        kind: "other",
        code: null,
        url: null,
        receivedAt,
        expiresAt: receivedAt + OTHER_TTL_SECONDS,
        rawSize: 10,
      });
    }

    const entries = await repos.mailInbox.listRecent(2);

    expect(entries.map((entry) => entry.receivedAt)).toEqual([3000, 2000]);
  });
});

describe("mailInbox.purgeExpired", () => {
  it("drops rows past their expiry and keeps ones still inside it", async () => {
    const repos = testRepos();
    const expired = await seedOtp("111111", 1000);
    const live = await repos.mailInbox.insert({
      fromAddr: PORTAL_SENDER,
      subject: "other",
      kind: "other",
      code: null,
      url: null,
      receivedAt: 1000,
      expiresAt: 1000 + OTHER_TTL_SECONDS,
      rawSize: 50,
    });

    const removed = await repos.mailInbox.purgeExpired(1000 + OTP_TTL_SECONDS + 1);

    expect(removed).toBe(1);
    const remaining = await repos.mailInbox.listRecent(10);
    expect(remaining.map((entry) => entry.id)).toEqual([live.id]);
    expect(remaining.map((entry) => entry.id)).not.toContain(expired.id);
  });

  it("drops a row past the hard age ceiling even with no expiry at all", async () => {
    // The backstop for a row written before every kind had a TTL: without it, an
    // attacker-chosen sender sat in D1 indefinitely. Written with raw SQL
    // because the repo cannot produce this shape any more, which is the point.
    const repos = testRepos();
    await seedLegacyRowWithoutTtl("legacy-1", 2000);

    const removed = await repos.mailInbox.purgeExpired(2000 + SEVEN_DAYS + 1);

    expect(removed).toBe(1);
    expect(await repos.mailInbox.listRecent(10)).toStrictEqual([]);
  });
});
