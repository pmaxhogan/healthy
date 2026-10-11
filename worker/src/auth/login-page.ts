// The password wall.
//
// A plain HTML form, no script: the CSP allows no inline script and the page has
// to work before any asset from the SPA build has been served. `x-healthy-auth:
// required` marks the response as an auth wall rather than app content, which is
// what lets the SPA's fetch layer (and a future service worker) tell "your
// session expired" from "the server returned a page".

import { escapeHtml, htmlPage, htmlResponse } from "../public/html.ts";

/** Response header naming this response as the auth wall. Also used on JSON 401s. */
export const AUTH_REQUIRED_HEADER = "x-healthy-auth";
export const AUTH_REQUIRED_VALUE = "required";

export interface LoginPageOptions {
  /** CSP nonce for the inline <style> block. */
  nonce: string;
  /** Shown above the field. Present only after a rejected attempt. */
  error?: string | undefined;
  /** Same-origin path to return to after login; becomes `?next=` on the form action. */
  next?: string | undefined;
  /**
   * HTTP status. Defaults to 401: this response *is* the refusal, and a 200 here
   * would make an expired session indistinguishable from a successful page load
   * to anything that only looks at the status line.
   */
  status?: number | undefined;
  /** Extra response headers, e.g. `retry-after` when the limiter has closed. */
  headers?: Record<string, string> | undefined;
}

/** Renders the login wall. */
export function loginPage(options: LoginPageOptions): Response {
  const action =
    options.next === undefined
      ? "/auth/login"
      : `/auth/login?next=${escapeHtml(encodeURIComponent(options.next))}`;

  const error =
    options.error === undefined ? "" : `  <p class="error">${escapeHtml(options.error)}</p>\n`;

  const body = `<main>
<form method="post" action="${action}">
  <h1>Healthy</h1>
${error}  <input
    type="password"
    name="password"
    aria-label="Password"
    placeholder="Password"
    autocomplete="current-password"
    autofocus
    required
  >
  <button type="submit">Sign in</button>
</form>
</main>`;

  return htmlResponse(
    htmlPage({ title: "Healthy", nonce: options.nonce, body, bodyClass: "login" }),
    options.status ?? 401,
    { [AUTH_REQUIRED_HEADER]: AUTH_REQUIRED_VALUE, ...options.headers },
  );
}
