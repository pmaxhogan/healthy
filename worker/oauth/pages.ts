/**
 * The HTML the OAuth routes render when a flow cannot continue.
 *
 * These are not API responses. Every route under `/oauth` is reached by a
 * top-level browser navigation -- the owner clicking "connect", or a provider
 * redirecting back -- so the only useful answer to a failure is a page that says
 * what happened and offers a link that fixes it. A JSON body here would be a raw
 * `{"error":...}` rendered as text in the address bar.
 *
 * Two rules the copy follows:
 *
 *  - **Never name the organisation.** `provider.display_name` is user data and the
 *    logs must not carry it; a page that a provider's error redirect can cause is
 *    not a place to start making exceptions. The pages say "this connection".
 *  - **Never quote the provider's own error text.** `error_description` comes from
 *    a third party and lands in a document; it is reported as a stable code and
 *    nothing else.
 */

import { escapeHtml, htmlPage, htmlResponse } from "../public/html.ts";

import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface OAuthPageOptions {
  nonce: string;
  heading: string;
  /** One or two sentences of plain prose. Escaped for you. */
  detail: string;
  /** A stable code shown in small print, so a report can quote something exact. */
  code?: string;
  status?: ContentfulStatusCode;
  /** Where the "try again" link points. Defaults to the app root. */
  retryPath?: string;
  retryLabel?: string;
}

/** A failure page for any point in an OAuth flow. */
export function oauthPage(options: OAuthPageOptions): Response {
  const retryPath = options.retryPath ?? "/";
  const retryLabel = options.retryLabel ?? "Back to Healthy";
  const code =
    options.code === undefined
      ? ""
      : `\n<p><small>Reference: <code>${escapeHtml(options.code)}</code></small></p>`;
  const body = `<main>
<h1>${escapeHtml(options.heading)}</h1>
<p>${escapeHtml(options.detail)}</p>${code}
<p><a href="${escapeHtml(retryPath)}">${escapeHtml(retryLabel)}</a></p>
</main>`;
  return htmlResponse(
    htmlPage({ title: "Healthy", nonce: options.nonce, body }),
    options.status ?? 400,
  );
}

/**
 * The page for a state that did not validate.
 *
 * One page for every reason -- unknown, already redeemed, expired, wrong kind --
 * because the caller cannot be told which without telling an attacker the same
 * thing. 400, because the request is malformed, not because the owner is
 * unauthenticated: they cleared both gates to get here.
 */
export function invalidStatePage(nonce: string): Response {
  return oauthPage({
    nonce,
    heading: "This link has expired",
    detail:
      "A connection link is good for ten minutes and can only be used once. Start the connection again from the dashboard.",
    code: "invalid_state",
    status: 400,
  });
}

/** The page for an `error=` parameter on the way back from a provider. */
export function authorizationRefusedPage(nonce: string, code: string, retryPath: string): Response {
  return oauthPage({
    nonce,
    heading: "The connection was not completed",
    detail:
      "The patient portal did not authorise Healthy. That usually means the sign-in was cancelled, or a consent screen was declined -- nothing has changed on this side, so it is safe to try again.",
    code,
    status: 400,
    retryPath,
    retryLabel: "Try again",
  });
}
