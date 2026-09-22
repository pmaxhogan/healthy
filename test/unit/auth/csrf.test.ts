import { describe, expect, it } from "vitest";

import {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  checkCsrf,
  hasSameOriginProof,
  isStateChanging,
} from "../../../worker/auth/csrf.ts";

const ORIGIN = "https://healthy.example";
const URL_UNDER_TEST = `${ORIGIN}/api/settings`;

function request(method: string, headers: Record<string, string> = {}): Request {
  return new Request(URL_UNDER_TEST, { method, headers });
}

describe("isStateChanging", () => {
  it("covers the four mutating methods and nothing else", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post", "delete"]) {
      expect(isStateChanging(method), method).toBe(true);
    }
    for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
      expect(isStateChanging(method), method).toBe(false);
    }
  });
});

describe("hasSameOriginProof", () => {
  it("accepts a matching Origin", () => {
    expect(hasSameOriginProof(request("POST", { origin: ORIGIN }))).toBe(true);
  });

  it("accepts Sec-Fetch-Site: same-origin on its own", () => {
    expect(hasSameOriginProof(request("POST", { "sec-fetch-site": "same-origin" }))).toBe(true);
  });

  it("rejects a foreign Origin", () => {
    expect(hasSameOriginProof(request("POST", { origin: "https://evil.example" }))).toBe(false);
  });

  it("rejects a same-host Origin on the wrong scheme or port", () => {
    // Built by substitution rather than written out, because a literal `http://`
    // in source is auto-rewritten to `https://` by the lint autofixer -- which
    // would silently turn this case into the same-origin one.
    const insecure = ORIGIN.replace("https:", "http:");

    expect(hasSameOriginProof(request("POST", { origin: insecure }))).toBe(false);
    expect(hasSameOriginProof(request("POST", { origin: `${ORIGIN}:8443` }))).toBe(false);
  });

  it("rejects the other Sec-Fetch-Site values", () => {
    for (const site of ["cross-site", "same-site", "none"]) {
      expect(hasSameOriginProof(request("POST", { "sec-fetch-site": site })), site).toBe(false);
    }
  });

  it("rejects a request carrying neither signal", () => {
    // A POST with no Origin is a client too old to be trusted with the admin
    // surface, not a request to wave through.
    expect(hasSameOriginProof(request("POST"))).toBe(false);
  });
});

describe("checkCsrf", () => {
  it("lets safe methods through untouched", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(checkCsrf(request(method)), method).toBe(true);
    }
  });

  describe("with the header required (the /api and /auth/logout contract)", () => {
    it("accepts origin proof plus the header", () => {
      const accepted = [
        { origin: ORIGIN, [CSRF_HEADER]: CSRF_HEADER_VALUE },
        { "sec-fetch-site": "same-origin", [CSRF_HEADER]: CSRF_HEADER_VALUE },
        { origin: ORIGIN, "sec-fetch-site": "same-origin", [CSRF_HEADER]: CSRF_HEADER_VALUE },
      ];

      for (const headers of accepted) {
        expect(checkCsrf(request("POST", headers)), JSON.stringify(headers)).toBe(true);
      }
    });

    it("rejects the header without origin proof", () => {
      expect(checkCsrf(request("POST", { [CSRF_HEADER]: CSRF_HEADER_VALUE }))).toBe(false);
      expect(
        checkCsrf(
          request("POST", { origin: "https://evil.example", [CSRF_HEADER]: CSRF_HEADER_VALUE }),
        ),
      ).toBe(false);
    });

    it("rejects origin proof without the header", () => {
      expect(checkCsrf(request("POST", { origin: ORIGIN }))).toBe(false);
      expect(checkCsrf(request("POST", { "sec-fetch-site": "same-origin" }))).toBe(false);
    });

    it("rejects the header set to anything other than the agreed value", () => {
      for (const value of ["", "0", "true", "yes"]) {
        expect(
          checkCsrf(request("POST", { origin: ORIGIN, [CSRF_HEADER]: value })),
          JSON.stringify(value),
        ).toBe(false);
      }
    });

    it("applies to every mutating method, not just POST", () => {
      for (const method of ["PUT", "PATCH", "DELETE"]) {
        expect(checkCsrf(request(method, { origin: ORIGIN })), method).toBe(false);
        expect(
          checkCsrf(request(method, { origin: ORIGIN, [CSRF_HEADER]: CSRF_HEADER_VALUE })),
          method,
        ).toBe(true);
      }
    });
  });

  describe("with the header waived (the /auth/login form)", () => {
    // An HTML form cannot set a request header, so login is checked with the
    // origin proof alone. Origin is sent on every browser POST, and the session
    // cookie it returns is SameSite=Strict.
    const options = { requireHeader: false };

    it("accepts origin proof alone", () => {
      expect(checkCsrf(request("POST", { origin: ORIGIN }), options)).toBe(true);
      expect(checkCsrf(request("POST", { "sec-fetch-site": "same-origin" }), options)).toBe(true);
    });

    it("still requires the origin proof", () => {
      expect(checkCsrf(request("POST"), options)).toBe(false);
      expect(checkCsrf(request("POST", { origin: "https://evil.example" }), options)).toBe(false);
      expect(checkCsrf(request("POST", { "sec-fetch-site": "cross-site" }), options)).toBe(false);
    });
  });
});
