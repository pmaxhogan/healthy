// Synthetic MIME messages only -- see CLAUDE.md: no real health-system name,
// sender domain or address may appear in a tracked file. Every domain below is
// an RFC 2606 reserved one (`.example`, `.test`) or the one real address this
// pipeline is allowed to name in code: Gmail's own forwarding-verification
// sender.

import { describe, expect, it } from "vitest";

import { parseInboundEmail } from "../../../worker/mail/parse.ts";

const OTP_EMAIL = [
  "From: MyChart <noreply@mychart.example.org>",
  "To: 2fa@healthy.example.test",
  "Subject: Your MyChart security code",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Your MyChart verification code is: 482913",
  "This code expires in 15 minutes.",
].join("\r\n");

const HTML_EMAIL = [
  "From: MyChart <noreply@mychart.example.org>",
  "To: 2fa@healthy.example.test",
  "Subject: Your MyChart security code",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>Your code is <b>482913</b>.</p>",
].join("\r\n");

describe("parseInboundEmail", () => {
  it("extracts the header From address, lower-cased, never the envelope sender", async () => {
    const parsed = await parseInboundEmail(OTP_EMAIL, OTP_EMAIL.length, 1000);
    expect(parsed.from).toBe("noreply@mychart.example.org");
  });

  it("extracts the subject and plain-text body", async () => {
    const parsed = await parseInboundEmail(OTP_EMAIL, OTP_EMAIL.length, 1000);
    expect(parsed.subject).toBe("Your MyChart security code");
    expect(parsed.text).toContain("482913");
  });

  it("passes rawSize and receivedAt through from the caller, not the message", async () => {
    const parsed = await parseInboundEmail(OTP_EMAIL, 99_999, 1_234_567);
    expect(parsed.rawSize).toBe(99_999);
    expect(parsed.receivedAt).toBe(1_234_567);
  });

  it("never surfaces an html body -- only .text is on the returned shape", async () => {
    const parsed = await parseInboundEmail(HTML_EMAIL, HTML_EMAIL.length, 1000);
    expect(Object.keys(parsed).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "from",
      "rawSize",
      "receivedAt",
      "subject",
      "text",
    ]);
    // No html-to-text fallback: an HTML-only message parses to an empty body
    // rather than reaching into markup for a code.
    expect(parsed.text).toBe("");
  });

  it("lower-cases an upper-case From address", async () => {
    const raw = OTP_EMAIL.replace("noreply@mychart.example.org", "NoReply@MyChart.EXAMPLE.org");
    const parsed = await parseInboundEmail(raw, raw.length, 1000);
    expect(parsed.from).toBe("noreply@mychart.example.org");
  });
});
