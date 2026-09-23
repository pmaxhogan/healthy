// `/api/mail` -- the recent-entries list, the sender allowlist, and the
// synthetic-entry test route.

import { describe, expect, it } from "vitest";

import { DEFAULT_MAIL_SENDER_ALLOWLIST } from "../../../worker/mail/classify.ts";

import { freshOwner, json, testRepos } from "./helpers.ts";

import type { ApiError, MailInboxEntryDto, MailSettingsDto } from "@shared/types.ts";

const owner = freshOwner();

describe("GET /api/mail/inbox", () => {
  it("starts empty", async () => {
    expect(await json<MailInboxEntryDto[]>(await owner().get("/api/mail/inbox"))).toStrictEqual([]);
  });

  it("lists entries newest first, with only the sender domain -- never the full address", async () => {
    const repos = testRepos();
    await repos.mailInbox.insert({
      fromAddr: "noreply@mychart.example.org",
      subject: "Your MyChart security code",
      kind: "otp",
      code: "482913",
      url: null,
      receivedAt: 1000,
      expiresAt: 1600,
      rawSize: 512,
    });
    await repos.mailInbox.insert({
      fromAddr: "forwarding-noreply@google.com",
      subject: "Gmail Forwarding Confirmation",
      kind: "forward_verify",
      code: "123456789",
      url: "https://mail-settings.google.com/mail/vf-abc",
      receivedAt: 2000,
      expiresAt: 2000 + 6 * 60 * 60,
      rawSize: 700,
    });

    const entries = await json<MailInboxEntryDto[]>(await owner().get("/api/mail/inbox"));

    expect(entries).toHaveLength(2);
    expect(entries[0]?.fromDomain).toBe("google.com");
    expect(entries[1]?.fromDomain).toBe("mychart.example.org");
    expect(JSON.stringify(entries)).not.toContain("@");
  });

  it("never returns an otp row's code, but does return a forward_verify's", async () => {
    const repos = testRepos();
    await repos.mailInbox.insert({
      fromAddr: "noreply@mychart.example.org",
      subject: "code",
      kind: "otp",
      code: "482913",
      url: null,
      receivedAt: 1000,
      expiresAt: 1600,
      rawSize: 512,
    });
    await repos.mailInbox.insert({
      fromAddr: "forwarding-noreply@google.com",
      subject: "Gmail Forwarding Confirmation",
      kind: "forward_verify",
      code: "123456789",
      url: "https://mail-settings.google.com/mail/vf-abc",
      receivedAt: 2000,
      expiresAt: 2000 + 6 * 60 * 60,
      rawSize: 700,
    });

    const entries = await json<MailInboxEntryDto[]>(await owner().get("/api/mail/inbox"));
    const body = JSON.stringify(entries);

    expect(body).not.toContain("482913");
    expect(body).toContain("123456789");
    const otp = entries.find((entry) => entry.kind === "otp");
    const forwardVerify = entries.find((entry) => entry.kind === "forward_verify");
    expect(otp?.pendingCode).toBeNull();
    expect(forwardVerify?.pendingCode).toBe("123456789");
    expect(forwardVerify?.pendingUrl).toBe("https://mail-settings.google.com/mail/vf-abc");
  });

  it("honours ?limit=", async () => {
    const repos = testRepos();
    for (const receivedAt of [1000, 2000, 3000]) {
      await repos.mailInbox.insert({
        fromAddr: "noreply@mychart.example.org",
        subject: "s",
        kind: "other",
        code: null,
        url: null,
        receivedAt,
        expiresAt: receivedAt + 24 * 60 * 60,
        rawSize: 10,
      });
    }

    expect(
      await json<MailInboxEntryDto[]>(await owner().get("/api/mail/inbox?limit=2")),
    ).toHaveLength(2);
  });

  it("is never cached", async () => {
    const response = await owner().get("/api/mail/inbox");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET /api/mail/settings", () => {
  it("answers with the shipped default allowlist on a freshly migrated database", async () => {
    const dto = await json<MailSettingsDto>(await owner().get("/api/mail/settings"));

    expect(dto.allowlist).toEqual([...DEFAULT_MAIL_SENDER_ALLOWLIST]);
  });
});

describe("PUT /api/mail/settings", () => {
  it("replaces the allowlist and answers with the stored state", async () => {
    const response = await owner().send("PUT", "/api/mail/settings", {
      allowlist: ["myhealthsystem.example.org", "google.com"],
    });

    expect(response.status).toBe(200);
    const dto = await json<MailSettingsDto>(response);
    expect(dto.allowlist).toEqual(["myhealthsystem.example.org", "google.com"]);

    const reread = await json<MailSettingsDto>(await owner().get("/api/mail/settings"));
    expect(reread.allowlist).toEqual(["myhealthsystem.example.org", "google.com"]);
  });

  it("normalises case and whitespace", async () => {
    const response = await owner().send("PUT", "/api/mail/settings", {
      allowlist: ["  MyChart.Example.ORG ", "Google.COM"],
    });

    const dto = await json<MailSettingsDto>(response);
    expect(dto.allowlist).toEqual(["mychart.example.org", "google.com"]);
  });

  it.each([
    ["a bare fragment", "mychart."],
    ["a single label", "localhost"],
    ["one character", "e"],
    ["a whole URL", "https://portal.example.org/"],
    ["an address", "noreply@portal.example.org"],
  ])("rejects %s as an allowlist entry", async (_label, entry) => {
    // Containment matching is gone, so an entry has to be a domain of at least
    // two labels: a fragment would silently match nothing, and a one-character
    // entry used to match most of the internet.
    const response = await owner().send("PUT", "/api/mail/settings", { allowlist: [entry] });

    expect(response.status).toBe(400);
    const body = await json<ApiError>(response);
    expect(body.error).toBe("bad_request");
  });

  it("rejects an empty allowlist", async () => {
    const response = await owner().send("PUT", "/api/mail/settings", { allowlist: [] });

    expect(response.status).toBe(400);
    const body = await json<ApiError>(response);
    expect(body.error).toBe("bad_request");
  });

  it("rejects an unknown field", async () => {
    const response = await owner().send("PUT", "/api/mail/settings", {
      allowlist: ["google.com"],
      extra: "nope",
    });

    expect(response.status).toBe(400);
  });
});

describe("POST /api/mail/test", () => {
  it("inserts a synthetic 'other' entry and sends no email", async () => {
    const response = await owner().send("POST", "/api/mail/test");

    expect(response.status).toBe(201);
    const entry = await json<MailInboxEntryDto>(response);
    expect(entry.kind).toBe("other");
    expect(entry.pendingCode).toBeNull();

    const listed = await json<MailInboxEntryDto[]>(await owner().get("/api/mail/inbox"));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(entry.id);
  });

  it("gives the synthetic entry a TTL, so a test row is not retained for ever", async () => {
    const entry = await json<MailInboxEntryDto>(await owner().send("POST", "/api/mail/test"));

    expect(entry.expiresAt).not.toBeNull();
  });
});
