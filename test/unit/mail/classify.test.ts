// Synthetic senders and bodies only, per CLAUDE.md -- RFC 2606 domains
// (`.example`, `.test`) everywhere except Gmail's own real, public
// forwarding-verification sender, which this module names deliberately.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAIL_SENDER_ALLOWLIST,
  DEFAULT_MAIL_SENDER_ALLOWLIST_CSV,
  GMAIL_FORWARD_VERIFY_SENDER,
  classify,
  domainOf,
  formatAllowlistCsv,
  isAllowedSender,
  parseAllowlistCsv,
} from "../../../worker/mail/classify.ts";

describe("domainOf", () => {
  it("returns the part after the last @, lower-cased", () => {
    expect(domainOf("NoReply@MyChart.Example.ORG")).toBe("mychart.example.org");
  });

  it("returns empty string for an address with no @", () => {
    expect(domainOf("not-an-address")).toBe("");
  });
});

describe("parseAllowlistCsv / formatAllowlistCsv", () => {
  it("splits, trims and lower-cases", () => {
    expect(parseAllowlistCsv(" MyChart. , Google.com ,,")).toEqual(["mychart.", "google.com"]);
  });

  it("round-trips through formatAllowlistCsv", () => {
    expect(formatAllowlistCsv([" MyChart. ", "Google.com"])).toBe("mychart.,google.com");
  });

  it("ships with the documented default", () => {
    expect(parseAllowlistCsv(DEFAULT_MAIL_SENDER_ALLOWLIST_CSV)).toEqual([
      ...DEFAULT_MAIL_SENDER_ALLOWLIST,
    ]);
  });
});

describe("isAllowedSender", () => {
  const allowlist = parseAllowlistCsv(DEFAULT_MAIL_SENDER_ALLOWLIST_CSV);

  it("matches a domain that contains the generic 'mychart.' fragment", () => {
    expect(isAllowedSender("noreply@mychart.example.org", allowlist)).toBe(true);
    expect(isAllowedSender("noreply@some-org.mychart.example.net", allowlist)).toBe(true);
  });

  it("matches the exact google.com entry, for Gmail's own sender", () => {
    expect(isAllowedSender(GMAIL_FORWARD_VERIFY_SENDER, allowlist)).toBe(true);
  });

  it("rejects a sender not on the list", () => {
    expect(isAllowedSender("spammer@not-allowed.example.net", allowlist)).toBe(false);
  });

  it("rejects an address with no domain", () => {
    expect(isAllowedSender("not-an-address", allowlist)).toBe(false);
  });

  it("matches a full domain the owner pasted in exactly", () => {
    expect(
      isAllowedSender("noreply@myhealthsystem.example.org", ["myhealthsystem.example.org"]),
    ).toBe(true);
  });
});

describe("classify", () => {
  it("recognises an OTP email from an allowlisted MyChart-style sender", () => {
    const result = classify({
      from: "noreply@mychart.example.org",
      subject: "Your MyChart security code",
      text: "Your MyChart verification code is: 482913. This code expires in 15 minutes.",
    });
    expect(result).toEqual({ kind: "otp", code: "482913", url: null });
  });

  it("prefers the digit run nearest the word 'code' when several numbers appear", () => {
    const result = classify({
      from: "noreply@mychart.example.org",
      subject: "Your MyChart security code",
      text: "Reference 20260922. Your one-time code is 719284. Call 1-800-555-0100 if this was not you.",
    });
    expect(result.kind).toBe("otp");
    expect(result.code).toBe("719284");
  });

  it("classifies Gmail's own forwarding-confirmation email by sender, extracting the code and link", () => {
    const result = classify({
      from: GMAIL_FORWARD_VERIFY_SENDER,
      subject: "Gmail Forwarding Confirmation - Receive Mail from 2fa@healthy.example.test",
      text: [
        "You have received this mail to confirm forwarding of your Gmail account.",
        "Please click the link below to confirm this request:",
        "",
        "https://mail-settings.google.com/mail/vf-abc123XYZ",
        "",
        "Alternatively, enter the confirmation code shown below:",
        "Confirmation Code: 123456789",
      ].join("\n"),
    });
    expect(result.kind).toBe("forward_verify");
    expect(result.code).toBe("123456789");
    expect(result.url).toBe("https://mail-settings.google.com/mail/vf-abc123XYZ");
  });

  it("trims trailing punctuation is not required -- the URL pattern already stops at whitespace/quotes", () => {
    const result = classify({
      from: GMAIL_FORWARD_VERIFY_SENDER,
      subject: "Gmail Forwarding Confirmation",
      text: "See (https://mail-settings.google.com/mail/vf-xyz) for the confirmation code 987654321.",
    });
    expect(result.url).toBe("https://mail-settings.google.com/mail/vf-xyz");
  });

  it("drops a javascript: URL planted in the body instead of a real confirmation link", () => {
    const result = classify({
      from: GMAIL_FORWARD_VERIFY_SENDER,
      subject: "Gmail Forwarding Confirmation",
      text: "Click here: javascript:alert(1) to confirm. Confirmation code: 123456789",
    });
    expect(result.kind).toBe("forward_verify");
    expect(result.url).toBeNull();
  });

  it("drops a data: URL planted in the body instead of a real confirmation link", () => {
    const result = classify({
      from: GMAIL_FORWARD_VERIFY_SENDER,
      subject: "Gmail Forwarding Confirmation",
      text: "See data:text/html,<script>alert(1)</script> for details. Confirmation code: 123456789",
    });
    expect(result.url).toBeNull();
  });

  it("drops an https URL whose host is not google.com, even if it looks like a link", () => {
    const result = classify({
      from: GMAIL_FORWARD_VERIFY_SENDER,
      subject: "Gmail Forwarding Confirmation",
      text: "Confirm here: https://attacker.example/phish. Confirmation code: 123456789",
    });
    expect(result.url).toBeNull();
    // A spoofed sibling link must not suppress the real code either.
    expect(result.code).toBe("123456789");
  });

  it("drops a plain http:// (non-https) link even to a google.com host", () => {
    const result = classify({
      from: GMAIL_FORWARD_VERIFY_SENDER,
      subject: "Gmail Forwarding Confirmation",
      // eslint-disable-next-line unicorn/prefer-https -- the whole point of this fixture is a non-https link, to prove isSafeForwardVerifyUrl rejects it.
      text: "Confirm here: http://mail-settings.google.com/mail/vf-abc. Confirmation code: 123456789",
    });
    expect(result.url).toBeNull();
  });

  it("keeps a real google.com https confirmation link", () => {
    const result = classify({
      from: GMAIL_FORWARD_VERIFY_SENDER,
      subject: "Gmail Forwarding Confirmation",
      text: "Confirm here: https://mail-settings.google.com/mail/vf-abc\nConfirmation code: 123456789",
    });
    expect(result.url).toBe("https://mail-settings.google.com/mail/vf-abc");
  });

  it("falls back to 'other' for an allowlisted sender whose content has no code", () => {
    const result = classify({
      from: "noreply@mychart.example.org",
      subject: "Your appointment reminder",
      text: "You have an upcoming appointment on Tuesday.",
    });
    expect(result).toEqual({ kind: "other", code: null, url: null });
  });

  it("falls back to 'other' for a hint word with no nearby digits at all", () => {
    const result = classify({
      from: "noreply@mychart.example.org",
      subject: "About your account",
      text: "Please refer to our code of conduct for more information.",
    });
    expect(result.kind).toBe("other");
    expect(result.code).toBeNull();
  });

  it("classifies by content alone, regardless of sender -- the allowlist gate lives in handler.ts", () => {
    // classify() trusts its caller to have already gated on the allowlist; this
    // pins that the *content* rule alone cannot distinguish spam from a real
    // code, which is exactly why handler.ts rejects by sender before this runs.
    const result = classify({
      from: "prizes@not-allowed.example.net",
      subject: "Your claim code",
      text: "Your claim code is 555000. Reply now to collect your prize!",
    });
    expect(result.kind).toBe("otp");
    expect(result.code).toBe("555000");
  });
});
