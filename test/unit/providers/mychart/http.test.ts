// `portalFetch`'s redirect rules, which are the ones that decide where a
// credential can end up.
//
// The rest of `http.ts` (cookies on intermediate hops, the empty-body rule, the
// WAF/challenge mapping) is exercised through `client.test.ts` and
// `discovery.test.ts` against realistic pages. What is pinned here is only the
// movement policy, because it is a security boundary and because the cases are
// easier to read as bare hops than as a scrape.
//
// Every host is invented and under a reserved TLD.

import { describe, expect, it } from "vitest";

import { noopLogger } from "../../../../worker/lib/log.ts";
import { portalFetch } from "../../../../worker/providers/mychart/http.ts";

import { html, redirect, stubPortal } from "./fixtures.ts";

import type { PortalFetchStub } from "./fixtures.ts";
import type { AppError } from "../../../../worker/lib/errors.ts";

const SITE = "https://portal.example-portal.test";
/** A second origin on the same registrable domain. */
const SIBLING = "https://alias.example-portal.test";
/** A different registrable domain entirely. */
const OFFSITE = "https://attacker.example";
/**
 * The same host over plain http.
 *
 * Derived rather than written out: a literal `http://` URL in this repository is
 * rewritten to `https://` by an eslint fixer, which would quietly turn the two
 * downgrade tests below into tests of nothing.
 */
const INSECURE = SITE.replace("https://", "http://");

function deps(stub: PortalFetchStub) {
  return { fetchImpl: stub.fetchImpl, logger: noopLogger, jar: undefined };
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error("expected the promise to reject");
}

describe("portalFetch: where a redirect may go", () => {
  it("follows a Location header to another origin on the same site", async () => {
    const stub = stubPortal((call) =>
      call.url.startsWith(SITE) ? redirect(`${SIBLING}/Home`) : html("<p>home</p>"),
    );

    const response = await portalFetch(deps(stub), { url: `${SITE}/Home`, endpoint: "Home" });

    expect(response.url).toBe(`${SIBLING}/Home`);
    expect(response.hops).toBe(1);
  });

  it("refuses a Location header that leaves the site, naming the origin for the UI", async () => {
    const stub = stubPortal(() => redirect(`${OFFSITE}/Home`));

    const error = await errorOf(portalFetch(deps(stub), { url: `${SITE}/Home`, endpoint: "Home" }));

    expect(error.code).toBe("portal_redirected_offsite");
    expect(error.details).toStrictEqual({ endpoint: "Home", landedOrigin: OFFSITE });
    // Refused before the second request is even made.
    expect(stub.calls).toHaveLength(1);
  });

  it("refuses a downgrade to http on the very same host", async () => {
    const stub = stubPortal(() => redirect(`${INSECURE}/Home`));

    const error = await errorOf(portalFetch(deps(stub), { url: `${SITE}/Home`, endpoint: "Home" }));

    expect(error.code).toBe("portal_insecure_redirect");
    // A scheme, never a host: this detail is safe in a log line.
    expect(error.details).toStrictEqual({ endpoint: "Home", scheme: "http:" });
    expect(stub.calls).toHaveLength(1);
  });

  it("refuses a first hop that is not https, before sending anything", async () => {
    const stub = stubPortal(() => html("<p>home</p>"));

    const error = await errorOf(
      portalFetch(deps(stub), { url: `${INSECURE}/Home`, endpoint: "Home" }),
    );

    expect(error.code).toBe("portal_insecure_redirect");
    expect(stub.calls).toStrictEqual([]);
  });

  it("follows a body redirect within the origin", async () => {
    const redirecting = `<script>window.location.href = "${SITE}/Landing";</script>`;
    const stub = stubPortal((call) => html(call.url.endsWith("/Home") ? redirecting : "<p>ok</p>"));

    const response = await portalFetch(deps(stub), {
      url: `${SITE}/Home`,
      endpoint: "Home",
      followBodyRedirects: true,
    });

    expect(response.url).toBe(`${SITE}/Landing`);
  });

  it("never follows a body redirect across an origin, even within the site", async () => {
    // A `<meta refresh>` or a `window.location` is content the page chose, and
    // the cheapest thing for a compromised page to inject. The 200 is returned
    // as-is instead, so a caller that was looking for a login form simply does
    // not find one.
    const body = `<meta http-equiv="refresh" content="0;url=${SIBLING}/Landing" />`;
    const stub = stubPortal(() => html(body));

    const response = await portalFetch(deps(stub), {
      url: `${SITE}/Home`,
      endpoint: "Home",
      followBodyRedirects: true,
    });

    expect(response.url).toBe(`${SITE}/Home`);
    expect(response.body).toBe(body);
    expect(stub.calls).toHaveLength(1);
  });
});

describe("portalFetch: caller headers on a hop that changed origin", () => {
  it("sends them on the first hop and drops them once the origin changes", async () => {
    const stub = stubPortal((call) =>
      call.url.startsWith(SITE) ? redirect(`${SIBLING}/Home`) : html("<p>home</p>"),
    );

    await portalFetch(deps(stub), {
      url: `${SITE}/Home`,
      endpoint: "Home",
      // Today an antiforgery token; an `Authorization` header the day one exists.
      headers: { "x-antiforgery": "token-value" },
    });

    expect(stub.calls[0]?.headers["x-antiforgery"]).toBe("token-value");
    expect(stub.calls[1]?.headers["x-antiforgery"]).toBeUndefined();
    // The browser-shaped headers still go, so the hop still looks like a browser.
    expect(stub.calls[1]?.headers.accept).toBeDefined();
  });
});
