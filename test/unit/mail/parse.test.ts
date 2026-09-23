// Synthetic MIME messages only -- see CLAUDE.md: no real health-system name,
// sender domain or address may appear in a tracked file. Every domain below is
// an RFC 2606 reserved one (`.example`, `.test`) or the one real address this
// pipeline is allowed to name in code: Gmail's own forwarding-verification
// sender.

import { describe, expect, it } from "vitest";

import { classify } from "../../../worker/mail/classify.ts";
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

/** Single-part `text/html`, no `text/plain` alternative at all -- the shape of the live bug. */
const HTML_EMAIL = [
  "From: MyChart <noreply@mychart.example.org>",
  "To: 2fa@healthy.example.test",
  "Subject: Your MyChart security code",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<html><body><p>Your MyChart verification token is <b>507218</b>. " +
    "It will expire within 5 minutes.</p></body></html>",
].join("\r\n");

/** `multipart/alternative` whose only alternative is HTML -- no `text/plain` part to fall back to. */
const MULTIPART_HTML_ONLY_EMAIL = [
  "From: MyChart <noreply@mychart.example.org>",
  "To: 2fa@healthy.example.test",
  "Subject: Your MyChart security code",
  'Content-Type: multipart/alternative; boundary="BOUNDARY"',
  "",
  "--BOUNDARY",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<html><body><p>Your MyChart verification token is <b>507218</b>. " +
    "It will expire within 5 minutes.</p></body></html>",
  "--BOUNDARY--",
  "",
].join("\r\n");

/** `multipart/alternative` with both a `text/plain` and a `text/html` part, carrying different codes. */
const MULTIPART_BOTH_PARTS_EMAIL = [
  "From: MyChart <noreply@mychart.example.org>",
  "To: 2fa@healthy.example.test",
  "Subject: Your MyChart security code",
  'Content-Type: multipart/alternative; boundary="BOUNDARY"',
  "",
  "--BOUNDARY",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Your MyChart verification token is 482913. It will expire within 5 minutes.",
  "--BOUNDARY",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>Your MyChart verification token is <b>999999</b>. It will expire within 5 minutes.</p>",
  "--BOUNDARY--",
  "",
].join("\r\n");

/** Named and numeric entities the flattener has to decode, including the code itself as decimal entities. */
const ENTITY_HTML_EMAIL = [
  "From: MyChart <noreply@mychart.example.org>",
  "To: 2fa@healthy.example.test",
  "Subject: Your MyChart security code",
  "Content-Type: text/html; charset=utf-8",
  "",
  // "507218" spelled out as decimal numeric entities (&#53; = '5', etc.), plus
  // a hex one, named entities, and a deliberately double-escaped "&lt;" that
  // must survive as literal text, not become a real "<".
  "<p>MyChart says &quot;hi&quot; &amp; welcome, Ren&#39;e. Your verification token is " +
    "&#53;&#48;&#55;&#x32;&#49;&#56;. It will expire in &lt;5&gt; minutes &nbsp; " +
    "(escaped: &amp;lt;not-a-tag&amp;gt;).</p>",
].join("\r\n");

/** `<script>`, `<style>` and `<head>` content that must never reach the extracted text. */
const HIDDEN_BLOCK_HTML_EMAIL = [
  "From: MyChart <noreply@mychart.example.org>",
  "To: 2fa@healthy.example.test",
  "Subject: Your MyChart security code",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<html><head><title>Secret 111111 title</title>" +
    "<style>.hidden { content: '222222'; }</style></head>" +
    "<body><script>var code = '333333'; report(code);</script>" +
    "<p>Your MyChart verification token is <b>507218</b>. " +
    "It will expire within 5 minutes.</p></body></html>",
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

  it("exposes only .text on the returned shape -- .html is never threaded through", async () => {
    const parsed = await parseInboundEmail(HTML_EMAIL, HTML_EMAIL.length, 1000);
    expect(Object.keys(parsed).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "from",
      "rawSize",
      "receivedAt",
      "subject",
      "text",
    ]);
  });

  it("lower-cases an upper-case From address", async () => {
    const raw = OTP_EMAIL.replace("noreply@mychart.example.org", "NoReply@MyChart.EXAMPLE.org");
    const parsed = await parseInboundEmail(raw, raw.length, 1000);
    expect(parsed.from).toBe("noreply@mychart.example.org");
  });

  describe("HTML-only messages (no text/plain part at all)", () => {
    it("derives text from a single-part text/html message, and classify() finds the code", async () => {
      const parsed = await parseInboundEmail(HTML_EMAIL, HTML_EMAIL.length, 1000);
      expect(parsed.text).toContain("507218");

      const result = classify(parsed);
      expect(result.kind).toBe("otp");
      expect(result.code).toBe("507218");
      expect(result.reason).toBe("verification token");
    });

    it("derives text from a multipart/alternative message whose only part is html", async () => {
      const parsed = await parseInboundEmail(
        MULTIPART_HTML_ONLY_EMAIL,
        MULTIPART_HTML_ONLY_EMAIL.length,
        1000,
      );
      expect(parsed.text).toContain("507218");

      const result = classify(parsed);
      expect(result.kind).toBe("otp");
      expect(result.code).toBe("507218");
      expect(result.reason).toBe("verification token");
    });

    it("keeps the text/plain part when both a text and an html part exist", async () => {
      const parsed = await parseInboundEmail(
        MULTIPART_BOTH_PARTS_EMAIL,
        MULTIPART_BOTH_PARTS_EMAIL.length,
        1000,
      );
      expect(parsed.text).toContain("482913");
      expect(parsed.text).not.toContain("999999");
    });

    it("decodes named and numeric entities, including a double-escaped literal", async () => {
      const parsed = await parseInboundEmail(ENTITY_HTML_EMAIL, ENTITY_HTML_EMAIL.length, 1000);
      expect(parsed.text).toContain('"hi"');
      expect(parsed.text).toContain("& welcome");
      expect(parsed.text).toContain("Ren'e");
      // The decimal + hex numeric entities spell out the code itself.
      expect(parsed.text).toContain("507218");
      expect(parsed.text).toContain("<5>");
      // A double-escaped "&amp;lt;" must decode to the literal text "&lt;",
      // never all the way through to a real "<".
      expect(parsed.text).toContain("&lt;not-a-tag&gt;");
      expect(parsed.text).not.toMatch(/nbsp/i);

      const result = classify(parsed);
      expect(result.kind).toBe("otp");
      expect(result.code).toBe("507218");
    });

    it("never includes <script>, <style> or <head> content in the derived text", async () => {
      const parsed = await parseInboundEmail(
        HIDDEN_BLOCK_HTML_EMAIL,
        HIDDEN_BLOCK_HTML_EMAIL.length,
        1000,
      );
      expect(parsed.text).toContain("507218");
      expect(parsed.text).not.toContain("111111");
      expect(parsed.text).not.toContain("222222");
      expect(parsed.text).not.toContain("333333");
      expect(parsed.text).not.toContain("Secret");
      expect(parsed.text).not.toContain("report");

      const result = classify(parsed);
      expect(result.kind).toBe("otp");
      expect(result.code).toBe("507218");
    });
  });
});
