import { describe, expect, it } from "vitest";

import {
  AUTH_REQUIRED_HEADER,
  AUTH_REQUIRED_VALUE,
  loginPage,
} from "../../../worker/auth/login-page.ts";

const NONCE = "nonce-under-test";

async function render(options: Parameters<typeof loginPage>[0]): Promise<string> {
  return loginPage(options).text();
}

describe("loginPage", () => {
  it("is never cached, by any cache", async () => {
    // A cached auth wall is a stale auth wall: a service worker or a shared cache
    // that keeps this 401 will serve it after the owner has signed in.
    const response = loginPage({ nonce: NONCE });

    expect(response.headers.get("cache-control")).toBe("no-store");
    await response.text();
  });

  it("marks itself as the auth wall rather than app content", () => {
    const response = loginPage({ nonce: NONCE });

    expect(response.headers.get(AUTH_REQUIRED_HEADER)).toBe(AUTH_REQUIRED_VALUE);
  });

  it("is a 401 by default, so an expired session is visible from the status line", () => {
    expect(loginPage({ nonce: NONCE }).status).toBe(401);
  });

  it("serves HTML", () => {
    expect(loginPage({ nonce: NONCE }).headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
  });

  it("carries the CSP nonce on its one inline style block", async () => {
    const html = await render({ nonce: NONCE });

    expect(html).toContain(`<style nonce="${NONCE}">`);
    // Any other inline style would be blocked by the policy, so there must not be
    // one -- and no inline script at all.
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/\sstyle="/u);
  });

  it("posts a password field to /auth/login with the right autocomplete hint", async () => {
    const html = await render({ nonce: NONCE });

    expect(html).toContain('method="post"');
    expect(html).toContain('action="/auth/login"');
    expect(html).toContain('type="password"');
    expect(html).toContain('name="password"');
    // Without this, password managers offer to save a new password instead of
    // filling the existing one.
    expect(html).toContain('autocomplete="current-password"');
  });

  it("renders an error state when one is given, and none when it is not", async () => {
    expect(await render({ nonce: NONCE, error: "Wrong password." })).toContain(
      '<p class="error">Wrong password.</p>',
    );
    expect(await render({ nonce: NONCE })).not.toContain('class="error"');
  });

  it("escapes the error text", async () => {
    const html = await render({ nonce: NONCE, error: '<img src=x onerror="alert(1)">' });

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("carries ?next on the form action, URL- and HTML-encoded", async () => {
    const html = await render({ nonce: NONCE, next: "/oauth/callback?code=abc&state=xyz" });

    expect(html).toContain(
      'action="/auth/login?next=%2Foauth%2Fcallback%3Fcode%3Dabc%26state%3Dxyz"',
    );
  });

  it("cannot be tricked into breaking out of the action attribute", async () => {
    const html = await render({ nonce: NONCE, next: '/x" onfocus="alert(1)' });

    // The payload survives as inert percent-encoded text; what must not survive is
    // the quote that would end the attribute and the `=` that would start another.
    expect(html).not.toContain('onfocus="');
    expect(html).toContain('action="/auth/login?next=%2Fx%22%20onfocus%3D%22alert(1)"');
  });

  it("accepts an overridden status and extra headers, as the limiter needs", async () => {
    const response = loginPage({
      nonce: NONCE,
      status: 429,
      error: "Too many attempts. Try again later.",
      headers: { "retry-after": "900" },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("900");
    expect(response.headers.get(AUTH_REQUIRED_HEADER)).toBe(AUTH_REQUIRED_VALUE);
    await response.text();
  });

  it("says nothing about the deployment or its operator", async () => {
    const rendered = await render({ nonce: NONCE, error: "Wrong password." });
    const html = rendered.toLowerCase();

    // The login wall is the page a misconfiguration would expose first, so it
    // names nothing: no operator, no version, no infrastructure, no link out.
    for (const leak of ["http://", "https://", "version", "cloudflare"]) {
      expect(html, leak).not.toContain(leak);
    }
    // Bounded character classes on purpose: a class containing `.` followed by a
    // literal `.` backtracks, which the lint rules reject.
    expect(html).not.toMatch(/@[\dA-Za-z-]+\.[a-z]{2,}/u);
  });
});
