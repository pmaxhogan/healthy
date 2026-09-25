import { describe, expect, it } from "vitest";

import { cleanPhone } from "../../../worker/lib/text.ts";

describe("cleanPhone", () => {
  it("strips the embedding marks a portal wraps a phone number in", () => {
    expect(cleanPhone("\u{202A}555-010-0199\u{202C}")).toBe("555-010-0199");
  });

  it("strips every bidi control, wherever it is, and trims", () => {
    expect(cleanPhone(" \u{200E}(555) \u{2066}010-0199\u{2069}\u{200F} ")).toBe("(555) 010-0199");
    expect(cleanPhone("\u{202B}\u{202D}555\u{202E}-0100\u{61C}")).toBe("555-0100");
  });

  it("leaves the number's own formatting alone", () => {
    expect(cleanPhone("+1 555.010.0199 ext. 4")).toBe("+1 555.010.0199 ext. 4");
  });

  it("is undefined when nothing is left", () => {
    expect(cleanPhone(undefined)).toBeUndefined();
    expect(cleanPhone("\u{202A}\u{202C}")).toBeUndefined();
    expect(cleanPhone("  ")).toBeUndefined();
  });
});
