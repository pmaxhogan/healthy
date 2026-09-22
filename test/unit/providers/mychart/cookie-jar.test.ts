// The jar is what carries a portal session between scheduled runs, so the rules
// that decide whether a cookie is stored and whether it is sent back are tested
// one at a time -- especially the two that are security properties rather than
// conveniences: a `Domain` the sending host has no right to, and `Secure`.

import { describe, expect, it } from "vitest";

import {
  CookieJar,
  defaultPath,
  domainMatches,
  pathMatches,
} from "../../../../worker/providers/mychart/cookie-jar.ts";

import type { CookieJarState } from "../../../../worker/providers/mychart/cookie-jar.ts";

const T0 = 1_767_225_600;
const PAGE = "https://portal.example-portal.test/MyChart/Authentication/Login";
/** The scheme a Secure cookie must never be sent over. See the test that uses it. */
const INSECURE_SCHEME = "http:";

function jar(now = T0): CookieJar {
  return new CookieJar({ now: () => now });
}

/** A Response carrying the given Set-Cookie headers, as several headers. */
function withCookies(...cookies: string[]): Response {
  const headers = new Headers();
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

describe("domainMatches", () => {
  it("accepts an exact match and a dot-boundary suffix", () => {
    expect(domainMatches("a.example.test", "a.example.test")).toBe(true);
    expect(domainMatches("a.example.test", "example.test")).toBe(true);
  });

  it("rejects a suffix that is not on a label boundary", () => {
    expect(domainMatches("evilexample.test", "example.test")).toBe(false);
  });

  it("never lets an IP address match a shorter suffix of itself", () => {
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- the literal IS the test: an IPv4 host must not domain-match a suffix of its own dotted quad.
    expect(domainMatches("10.0.0.1", "0.0.1")).toBe(false);
  });
});

describe("pathMatches", () => {
  it("matches the same path and anything below it", () => {
    expect(pathMatches("/MyChart", "/MyChart")).toBe(true);
    expect(pathMatches("/MyChart/Visits", "/MyChart")).toBe(true);
    expect(pathMatches("/MyChart/", "/MyChart/")).toBe(true);
  });

  it("does not match a sibling whose name merely starts the same way", () => {
    expect(pathMatches("/MyChartAdmin", "/MyChart")).toBe(false);
  });
});

describe("defaultPath", () => {
  it("is the directory of the request path, not the root", () => {
    expect(defaultPath("/MyChart/Authentication/Login")).toBe("/MyChart/Authentication");
    expect(defaultPath("/Login")).toBe("/");
    expect(defaultPath("/")).toBe("/");
  });
});

describe("CookieJar.setCookie", () => {
  it("stores a host-only cookie and sends it back to that host and path", () => {
    const cookies = jar();

    expect(cookies.setCookie(PAGE, "MCSession=abc; Path=/MyChart/; Secure; HttpOnly")).toBe(true);
    expect(cookies.getCookieHeader("https://portal.example-portal.test/MyChart/Visits")).toBe(
      "MCSession=abc",
    );
  });

  it("refuses a Domain the sending host does not belong to", () => {
    const cookies = jar();

    expect(cookies.setCookie(PAGE, "planted=1; Domain=other.test; Path=/")).toBe(false);
    expect(cookies.size).toBe(0);
  });

  it("accepts a Domain that is a parent of the sending host, and shares it", () => {
    const cookies = jar();

    expect(cookies.setCookie(PAGE, "shared=1; Domain=.example-portal.test; Path=/")).toBe(true);
    expect(cookies.getCookieHeader("https://other.example-portal.test/")).toBe("shared=1");
  });

  it("keeps a host-only cookie off a sibling host", () => {
    const cookies = jar();
    cookies.setCookie(PAGE, "only=1; Path=/");

    expect(cookies.getCookieHeader("https://other.example-portal.test/")).toBeNull();
  });

  it("defaults the path to the request directory when Path is absent", () => {
    const cookies = jar();
    cookies.setCookie(PAGE, "scoped=1");

    expect(cookies.getCookieHeader("https://portal.example-portal.test/MyChart/Authentication")) //
      .toBe("scoped=1");
    expect(cookies.getCookieHeader("https://portal.example-portal.test/MyChart/Visits")).toBeNull();
  });

  it("never sends a Secure cookie over plain http", () => {
    const cookies = jar();
    cookies.setCookie(PAGE, "MCSession=abc; Path=/; Secure");

    // Assembled from INSECURE_SCHEME rather than written out: a plaintext URL
    // literal is what `sonarjs/no-clear-text-protocols` rewrites to https, and
    // that autofix would quietly turn this assertion into the https case.
    expect(cookies.getCookieHeader(`${INSECURE_SCHEME}//portal.example-portal.test/MyChart/`)) //
      .toBeNull();
  });

  it("returns null rather than an empty header when nothing matches", () => {
    expect(jar().getCookieHeader("https://portal.example-portal.test/")).toBeNull();
  });

  it("lets Max-Age win over Expires", () => {
    const cookies = jar();
    cookies.setCookie(PAGE, "trust=1; Path=/; Max-Age=600; Expires=Thu, 01 Jan 1970 00:00:00 GMT");

    expect(cookies.has("https://portal.example-portal.test/MyChart/", "trust")).toBe(true);
  });

  it("treats a non-positive Max-Age as a deletion", () => {
    const cookies = jar();
    cookies.setCookie(PAGE, "gone=1; Path=/");
    expect(cookies.size).toBe(1);

    expect(cookies.setCookie(PAGE, "gone=1; Path=/; Max-Age=0")).toBe(false);
    expect(cookies.size).toBe(0);
  });

  it("drops a cookie once its expiry has passed", () => {
    const clock = { at: T0 };
    const cookies = new CookieJar({ now: () => clock.at });
    cookies.setCookie(PAGE, "short=1; Path=/; Max-Age=60");

    clock.at = T0 + 61;

    expect(cookies.size).toBe(0);
  });

  it("replaces a cookie of the same name, domain and path", () => {
    const cookies = jar();
    cookies.setCookie(PAGE, "MCSession=first; Path=/");
    cookies.setCookie(PAGE, "MCSession=second; Path=/");

    expect(cookies.size).toBe(1);
    expect(cookies.getCookieHeader("https://portal.example-portal.test/")).toBe("MCSession=second");
  });

  it("ignores a header with no name", () => {
    expect(jar().setCookie(PAGE, "=orphan; Path=/")).toBe(false);
    expect(jar().setCookie(PAGE, "novalue")).toBe(false);
  });

  it("sends longer paths before shorter ones", () => {
    const cookies = jar();
    cookies.setCookie(PAGE, "a=root; Path=/");
    cookies.setCookie(PAGE, "b=deep; Path=/MyChart/Visits");

    expect(cookies.getCookieHeader("https://portal.example-portal.test/MyChart/Visits/List")).toBe(
      "b=deep; a=root",
    );
  });
});

describe("CookieJar.setFromResponse", () => {
  it("stores every Set-Cookie on one response, including a dated one", () => {
    const cookies = jar();
    const stored = cookies.setFromResponse(
      PAGE,
      withCookies(
        "MCSession=abc; Path=/; Secure; HttpOnly",
        "trust=xyz; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT",
      ),
    );

    // A comma inside the Expires date is exactly why these have to be read as
    // separate headers rather than one joined string.
    expect(stored).toBe(2);
    expect(cookies.getCookieHeader("https://portal.example-portal.test/MyChart/")).toBe(
      "MCSession=abc; trust=xyz",
    );
  });
});

describe("CookieJar serialisation", () => {
  it("round-trips through JSON, keeping a session cookie", () => {
    const cookies = jar();
    cookies.setCookie(PAGE, "MCSession=abc; Path=/; Secure");
    cookies.setCookie(PAGE, "trust=xyz; Path=/; Max-Age=7776000");

    // The serialised shape is the file format of a sealed D1 column, so it is
    // asserted as such: a version and a cookie list, nothing else.
    const state = JSON.parse(cookies.serialise()) as CookieJarState;
    expect(state.v).toBe(1);
    expect(state.cookies.map((cookie) => cookie.name)).toStrictEqual(["MCSession", "trust"]);

    const restored = CookieJar.deserialise(cookies.serialise(), { now: () => T0 });

    // The session cookie (no expiry) survives on purpose: inheriting it is what
    // lets the next scheduled run skip the emailed code.
    expect(restored.getCookieHeader("https://portal.example-portal.test/MyChart/")).toBe(
      "MCSession=abc; trust=xyz",
    );
  });

  it("drops a cookie that expired while the jar was at rest", () => {
    const cookies = jar();
    cookies.setCookie(PAGE, "short=1; Path=/; Max-Age=60");
    const serialised = cookies.serialise();

    const restored = CookieJar.deserialise(serialised, { now: () => T0 + 3600 });

    expect(restored.size).toBe(0);
  });

  it("yields an empty jar for anything it cannot read, rather than throwing", () => {
    for (const bad of ["", "not json", "[]", "null", '{"v":1}', '{"cookies":"nope"}']) {
      expect(CookieJar.deserialise(bad, { now: () => T0 }).size, bad).toBe(0);
    }
  });

  it("skips a malformed entry but keeps the good ones", () => {
    const state = JSON.stringify({
      v: 1,
      cookies: [
        { name: "ok", value: "1", domain: "portal.example-portal.test", path: "/" },
        {
          name: "good",
          value: "2",
          domain: "portal.example-portal.test",
          path: "/",
          secure: false,
          hostOnly: true,
          expiresAt: null,
          createdAt: T0,
        },
      ],
    });

    const restored = CookieJar.deserialise(state, { now: () => T0 });

    expect(restored.size).toBe(1);
    expect(restored.getCookieHeader("https://portal.example-portal.test/")).toBe("good=2");
  });

  it("clear() forgets the session", () => {
    const cookies = jar();
    cookies.setCookie(PAGE, "MCSession=abc; Path=/");
    cookies.clear();

    expect(cookies.size).toBe(0);
  });
});

describe("extras", () => {
  // The sign-in spans Worker invocations: the emailed code is submitted by a new
  // client built from the sealed jar, so anything the second half needs and a
  // cookie cannot carry has to survive a serialise/deserialise round trip.
  it("survives a round trip alongside the cookies", () => {
    const store = jar();
    store.setCookie(PAGE, "session=abc; Path=/");
    store.setExtra("oidc.clientId", "1767225600000");

    const restored = CookieJar.deserialise(store.serialise(), { now: () => T0 });

    expect(restored.getExtra("oidc.clientId")).toBe("1767225600000");
    expect(restored.has(PAGE, "session")).toBe(true);
  });

  it("is null for a name that was never set", () => {
    expect(jar().getExtra("nothing")).toBeNull();
  });

  it("is never sent in a Cookie header", () => {
    const store = jar();
    store.setExtra("oidc.userId", "owner-login");

    expect(store.getCookieHeader(PAGE)).toBeNull();
    expect(store.size).toBe(0);
  });

  it("drops an entry set to the empty string", () => {
    const store = jar();
    store.setExtra("oidc.userId", "owner-login");
    store.setExtra("oidc.userId", "");

    expect(store.getExtra("oidc.userId")).toBeNull();
    // And then it is not written at all, rather than written as an empty object.
    expect(store.serialise()).not.toContain("extras");
  });

  it("omits the field entirely when there is nothing to carry", () => {
    expect(jar().serialise()).toBe(JSON.stringify({ v: 1, cookies: [] }));
  });

  it("tolerates a stored shape that is not a string map", () => {
    for (const bad of ['{"v":1,"cookies":[],"extras":null}', '{"v":1,"cookies":[],"extras":7}']) {
      expect(CookieJar.deserialise(bad).getExtra("anything"), bad).toBeNull();
    }
    const mixed = CookieJar.deserialise('{"v":1,"cookies":[],"extras":{"a":1,"b":"two"}}');
    expect(mixed.getExtra("a")).toBeNull();
    expect(mixed.getExtra("b")).toBe("two");
  });

  it("is cleared with the cookies", () => {
    const store = jar();
    store.setCookie(PAGE, "session=abc");
    store.setExtra("oidc.userId", "owner-login");

    store.clear();

    expect(store.getExtra("oidc.userId")).toBeNull();
    expect(store.size).toBe(0);
  });
});
