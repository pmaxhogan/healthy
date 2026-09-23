// The eTLD+1 heuristic two security rules lean on: whether a redirect has left
// the site (`http.ts`) and whether a cookie's `Domain=` names a public suffix
// (`cookie-jar.ts`). It is deliberately small -- a Worker has no room for a real
// public-suffix list -- so what these tests pin is that it is wrong only in the
// conservative direction.
//
// Every host below is invented, under a reserved TLD where one is needed.

import { describe, expect, it } from "vitest";

import {
  isPublicSuffix,
  registrableDomain,
  sameRegistrableSite,
} from "../../../../worker/ehr/mychart/site.ts";

describe("registrableDomain", () => {
  it.each([
    ["portal.example.test", "example.test"],
    ["a.b.c.example.test", "example.test"],
    ["example.test", "example.test"],
    ["EXAMPLE.TEST", "example.test"],
    // A trailing dot is the same name.
    ["portal.example.test.", "example.test"],
  ])("reduces %s to %s", (host, expected) => {
    expect(registrableDomain(host)).toBe(expected);
  });

  it.each([
    ["a.b.example.co.uk", "example.co.uk"],
    ["portal.example.com.au", "example.com.au"],
    ["example.co.jp", "example.co.jp"],
  ])("keeps three labels under a known second-level suffix: %s", (host, expected) => {
    expect(registrableDomain(host)).toBe(expected);
  });

  // An IPv4 literal ends in a digit, so a naive "last two labels" would reduce
  // `192.0.2.10` (RFC 5737 documentation range) to `2.10` and make it the same
  // site as every other address ending in those octets.
  it.each(["localhost", "192.0.2.10", "", "::1"])(
    "treats %s as its own site, with nothing to strip",
    (host) => {
      expect(registrableDomain(host)).toBe(host.toLowerCase());
    },
  );
});

describe("isPublicSuffix", () => {
  it.each(["test", "uk", "co.uk", "com.au", "localhost", ""])(
    "reports %s as a suffix nobody registers",
    (domain) => {
      expect(isPublicSuffix(domain)).toBe(true);
    },
  );

  it.each(["example.test", "example.co.uk", "a.example.test", "portal.example.com.au"])(
    "reports %s as a registrable name",
    (domain) => {
      expect(isPublicSuffix(domain)).toBe(false);
    },
  );
});

describe("sameRegistrableSite", () => {
  it("allows movement within the site the owner pasted", () => {
    expect(
      sameRegistrableSite("https://alias.example.test/x", "https://portal.example.test/y"),
    ).toBe(true);
  });

  it("refuses a different registrable domain, however similar it looks", () => {
    expect(sameRegistrableSite("https://portal.example.test", "https://attacker.example")).toBe(
      false,
    );
    // The case the whole rule exists for: a lookalike that shares a label but not
    // a site. `example.test.evil.test` reduces to `evil.test`.
    expect(
      sameRegistrableSite("https://portal.example.test", "https://example.test.evil.test"),
    ).toBe(false);
  });

  it("refuses two hosts under the same public suffix", () => {
    expect(sameRegistrableSite("https://a.example.co.uk", "https://b.other.co.uk")).toBe(false);
  });

  it("says no when either side is not a URL, which is the safe answer", () => {
    expect(sameRegistrableSite("not a url", "https://portal.example.test")).toBe(false);
    expect(sameRegistrableSite("https://portal.example.test", "not a url")).toBe(false);
  });

  it("compares hosts, not schemes or ports", () => {
    expect(
      sameRegistrableSite("https://portal.example.test", "https://portal.example.test:8443/x"),
    ).toBe(true);
  });
});
