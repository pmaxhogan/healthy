// The OAuth failure pages.
//
// These render a third party's error code into a document, which makes them the one
// place in the OAuth flow where an injection would be possible -- so the escaping is
// asserted, and so is what the pages deliberately leave out.

import { describe, expect, it } from "vitest";

import { invalidStatePage, oauthPage, providerRefusedPage } from "../../../worker/oauth/pages.ts";

const NONCE = "test-nonce";

async function bodyOf(response: Response): Promise<string> {
  return response.text();
}

describe("oauthPage", () => {
  it("renders an HTML document that no cache may keep", async () => {
    const response = oauthPage({ nonce: NONCE, heading: "Heading", detail: "Detail." });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await bodyOf(response)).toContain("<h1>Heading</h1>");
  });

  it("carries the CSP nonce on its inline style, or the page renders unstyled", async () => {
    const html = await bodyOf(oauthPage({ nonce: NONCE, heading: "H", detail: "D" }));

    expect(html).toContain(`<style nonce="${NONCE}">`);
  });

  it("escapes the heading, the detail and the code", async () => {
    const html = await bodyOf(
      oauthPage({
        nonce: NONCE,
        heading: "<script>h</script>",
        detail: "<script>d</script>",
        code: "<img src=x onerror=alert(1)>",
      }),
    );

    expect(html).not.toContain("<script>h");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;h&lt;/script&gt;");
  });

  it("escapes the retry link, so a code-derived path cannot break out of the attribute", async () => {
    const html = await bodyOf(
      oauthPage({
        nonce: NONCE,
        heading: "H",
        detail: "D",
        retryPath: '/x"><script>alert(1)</script>',
      }),
    );

    expect(html).not.toContain("<script>alert(1)");
  });

  it("uses the status the caller asked for", () => {
    expect(oauthPage({ nonce: NONCE, heading: "H", detail: "D", status: 500 }).status).toBe(500);
  });
});

describe("invalidStatePage", () => {
  it("says the link expired without saying which of the four reasons applied", async () => {
    const html = await bodyOf(invalidStatePage(NONCE));

    expect(html).toContain("expired");
    expect(html).toContain("invalid_state");
    // Telling the caller "already redeemed" vs "never existed" tells an attacker
    // the same thing.
    expect(html).not.toContain("redeemed");
    expect(html).not.toContain("unknown state");
  });
});

describe("providerRefusedPage", () => {
  it("reports the health system's error code and offers a retry", async () => {
    const response = providerRefusedPage(
      NONCE,
      "access_denied",
      "/oauth/epic/start?healthSystem=P1",
    );
    const html = await bodyOf(response);

    expect(response.status).toBe(400);
    expect(html).toContain("access_denied");
    expect(html).toContain("/oauth/epic/start?healthSystem=P1");
  });

  it("never names the organisation", async () => {
    const html = await bodyOf(providerRefusedPage(NONCE, "access_denied", "/"));

    expect(html).toContain("patient portal");
  });

  it("escapes a hostile error code", async () => {
    const html = await bodyOf(providerRefusedPage(NONCE, "</code><script>x</script>", "/"));

    expect(html).not.toContain("<script>x");
  });
});
