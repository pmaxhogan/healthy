// The `email()` pipeline end to end, in real workerd against real D1: size
// guard -> parse -> allowlist -> classify -> seal -> store.
//
// Every message body below is synthetic, per CLAUDE.md: RFC 2606 domains
// everywhere except Gmail's own real forwarding-verification sender.

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setSetting } from "../../../worker/db/settings.ts";
import { handleInboundEmail } from "../../../worker/mail/handler.ts";
import { resetDb, testCtx, testRepos } from "../db/helpers.ts";

import { fakeEmail, handlerEnv, randomDataKey } from "./helpers.ts";

beforeEach(resetDb);

const DATA_KEY = randomDataKey();
const ENV = handlerEnv(DATA_KEY);

const OTP_EMAIL = [
  "From: MyChart <noreply@mychart.example.org>",
  "To: 2fa@healthy.example.test",
  "Subject: Your MyChart security code",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Your MyChart verification code is: 482913",
  "This code expires in 15 minutes.",
].join("\r\n");

const GMAIL_VERIFY_EMAIL = [
  "From: Gmail Team <forwarding-noreply@google.com>",
  "To: 2fa@healthy.example.test",
  "Subject: Gmail Forwarding Confirmation - Receive Mail from 2fa@healthy.example.test",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Please click the link below to confirm this request:",
  "",
  "https://mail-settings.google.com/mail/vf-abc123XYZ",
  "",
  "Alternatively, enter the confirmation code shown below:",
  "Confirmation Code: 123456789",
].join("\r\n");

const SPAM_EMAIL = [
  "From: Prizes <prizes@not-allowed.example.net>",
  "To: 2fa@healthy.example.test",
  "Subject: Your claim code",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Your claim code is 555000. Reply now to collect your prize!",
].join("\r\n");

async function run(message: ForwardableEmailMessage): Promise<void> {
  const ctx = createExecutionContext();
  await handleInboundEmail(message, ENV, ctx);
  await waitOnExecutionContext(ctx);
}

describe("handleInboundEmail: accepted mail", () => {
  it("accepts an OTP email from the default MyChart-style allowlist and seals its code", async () => {
    const { message, rejections } = fakeEmail(OTP_EMAIL, {
      from: "noreply@mychart.example.org",
    });

    await run(message);

    expect(rejections).toEqual([]);
    const repos = testRepos({ dataKey: DATA_KEY });
    const entries = await repos.mailInbox.listRecent(10);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("otp");
    expect(entries[0]?.expiresAt).not.toBeNull();

    const claimed = await repos.mailInbox.takeFreshOtp({
      since: 0,
      now: entries[0]?.receivedAt ?? 0,
    });
    expect(claimed?.code).toBe("482913");
  });

  it("accepts Gmail's own forwarding-verification email and stores the code and link", async () => {
    const { message, rejections } = fakeEmail(GMAIL_VERIFY_EMAIL, {
      from: "forwarding-noreply@google.com",
    });

    await run(message);

    expect(rejections).toEqual([]);
    const repos = testRepos({ dataKey: DATA_KEY });
    const entries = await repos.mailInbox.listRecent(10);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("forward_verify");
    expect(entries[0]?.pendingCode).toBe("123456789");
    expect(entries[0]?.pendingUrl).toBe("https://mail-settings.google.com/mail/vf-abc123XYZ");
  });

  it("accepts mail from a tenant domain the owner added to the allowlist", async () => {
    await setSetting(
      testCtx({ dataKey: DATA_KEY }),
      "mail_sender_allowlist",
      "myhealthsystem.example.org,google.com",
    );
    const raw = OTP_EMAIL.replace("mychart.example.org", "myhealthsystem.example.org");
    const { message, rejections } = fakeEmail(raw, { from: "noreply@myhealthsystem.example.org" });

    await run(message);

    expect(rejections).toEqual([]);
    const entries = await testRepos({ dataKey: DATA_KEY }).mailInbox.listRecent(10);
    expect(entries).toHaveLength(1);
  });
});

describe("handleInboundEmail: rejected mail", () => {
  it("rejects mail from a sender not on the allowlist, storing nothing", async () => {
    const { message, rejections } = fakeEmail(SPAM_EMAIL, {
      from: "prizes@not-allowed.example.net",
    });

    await run(message);

    expect(rejections).toEqual(["not allowed"]);
    expect(await testRepos({ dataKey: DATA_KEY }).mailInbox.listRecent(10)).toStrictEqual([]);
  });

  it("rejects a tenant domain the owner has not yet added, even though it looks like an OTP", async () => {
    // The default allowlist is generic ("mychart.", "google.com"); an
    // organisation whose sending domain does not contain that fragment is
    // rejected until the owner adds it from the Mail settings page.
    const raw = OTP_EMAIL.replace("mychart.example.org", "unlisted-health.example.org");
    const { message, rejections } = fakeEmail(raw, { from: "noreply@unlisted-health.example.org" });

    await run(message);

    expect(rejections).toEqual(["not allowed"]);
    expect(await testRepos({ dataKey: DATA_KEY }).mailInbox.listRecent(10)).toStrictEqual([]);
  });

  it("rejects an oversized message before ever parsing it", async () => {
    const { message, rejections } = fakeEmail(OTP_EMAIL, {
      from: "noreply@mychart.example.org",
      rawSizeOverride: 2 * 1024 * 1024,
    });

    await run(message);

    expect(rejections).toEqual(["message too large"]);
    expect(await testRepos({ dataKey: DATA_KEY }).mailInbox.listRecent(10)).toStrictEqual([]);
  });
});

describe("handleInboundEmail: logging", () => {
  // handleInboundEmail builds its own logger via makeLogger's default console
  // sink; spying on console is the only way to see what it wrote without
  // threading a test logger through a Worker export. Redaction's own rules are
  // pinned by test/unit/lib/log.test.ts -- this is the behavioural half: that
  // an accepted message's log line carries a domain and an id, never the
  // address, the subject or the code. The spy implementation records the raw
  // line into a plain string array rather than being inspected through
  // `.mock.calls` afterwards, which sidesteps typing console's variadic
  // `(...data: unknown[]) => void` signature down to something narrower.
  let lines: string[] = [];

  function record(line: unknown): void {
    if (typeof line === "string") lines.push(line);
  }

  beforeEach(() => {
    lines = [];
    vi.spyOn(console, "log").mockImplementation(record);
    vi.spyOn(console, "warn").mockImplementation(record);
    vi.spyOn(console, "error").mockImplementation(record);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function loggedLines(): Record<string, unknown>[] {
    return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("names only the kind, sender domain, size and id for an accepted message", async () => {
    const { message } = fakeEmail(OTP_EMAIL, { from: "noreply@mychart.example.org" });

    await run(message);

    const accepted = loggedLines().find((line) => line.event === "mail.accepted");
    expect(accepted).toMatchObject({
      kind: "otp",
      fromDomain: "mychart.example.org",
      // The keyword that tipped classification into 'otp' -- see
      // worker/mail/classify.ts -- never the code itself (checked below).
      otp_match: "code is",
    });
    expect(accepted?.id).toEqual(expect.any(String));
    expect(JSON.stringify(accepted)).not.toContain("482913");
    expect(JSON.stringify(accepted)).not.toContain("noreply@");
  });

  it("names only the reason and sender domain for a rejected message, never the full address", async () => {
    const { message } = fakeEmail(SPAM_EMAIL, { from: "prizes@not-allowed.example.net" });

    await run(message);

    const rejected = loggedLines().find((line) => line.event === "mail.rejected");
    expect(rejected).toMatchObject({
      reason: "not_allowed",
      fromDomain: "not-allowed.example.net",
    });
    expect(JSON.stringify(rejected)).not.toContain("prizes@");
  });
});
