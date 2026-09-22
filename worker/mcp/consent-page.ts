/**
 * The consent screen: the most sensitive page in the application.
 *
 * Approving here hands a third-party MCP client read access to an entire medical
 * record, so what stands in front of it matters more than how it looks:
 *
 *  1. Cloudflare Access. The requesting client never reaches this page; the owner's
 *    browser does, and Access has already established that it is the owner.
 *  2. The password session, from `ownerGate` in `worker/app.ts`. The GET is a
 *    top-level navigation, which the `SameSite=Lax` cookie rides; if the session
 *    has lapsed the gate answers with the login form carrying `?next=` and
 *    signing in resumes the flow.
 *  3. Origin check on the POST (`csrfGuard`). An HTML form cannot send a custom
 *    header, so the same-origin proof is the CSRF defence here; see
 *    `worker/auth/csrf.ts`, which lists `/authorize` as header-exempt on purpose.
 *  4. `frame-ancestors 'none'`, so the page cannot be framed and click-jacked.
 *
 * The authorization request travels through the form as base64 JSON rather than
 * being kept server-side. It is not a capability: the POST is worthless without
 * the session cookie and a same-origin Origin, and everything inside it is
 * re-validated -- the client is looked up again and the redirect URI is checked
 * against that client's registration before either branch redirects anywhere.
 */

import { z } from "zod";

import { nowSeconds, toIso } from "../lib/time.ts";
import { escapeHtml, htmlPage, htmlResponse } from "../public/html.ts";

import { MCP_SCOPE, OWNER_USER_ID, oauthHelpers } from "./oauth-config.ts";

import type { Env } from "../env.ts";
import type { AuthRequest, ClientInfo, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/** RFC 8707 allows one resource indicator or several. */
const RESOURCE_INDICATOR = z.union([z.string(), z.array(z.string())]);

/** What the hidden field carries, validated on the way back in. */
const encodedRequestSchema = z.object({
  responseType: z.string().min(1),
  clientId: z.string().min(1),
  redirectUri: z.string().min(1),
  scope: z.array(z.string()),
  state: z.string(),
  codeChallenge: z.string().optional(),
  codeChallengeMethod: z.string().optional(),
  resource: RESOURCE_INDICATOR.optional(),
  issuer: z.string().optional(),
});

function encodeRequest(request: AuthRequest): string {
  return btoa(JSON.stringify(request));
}

/**
 * Decode the hidden field back into an `AuthRequest`.
 *
 * Rebuilt field by field rather than cast: `exactOptionalPropertyTypes` is on, so
 * an absent optional has to be absent rather than present-and-undefined, and doing
 * it explicitly is also what keeps an unexpected key out of the object that gets
 * handed to `completeAuthorization`.
 */
function decodeRequest(encoded: string): AuthRequest | null {
  let parsed: z.infer<typeof encodedRequestSchema>;
  try {
    parsed = encodedRequestSchema.parse(JSON.parse(atob(encoded)));
  } catch {
    return null;
  }
  return {
    responseType: parsed.responseType,
    clientId: parsed.clientId,
    redirectUri: parsed.redirectUri,
    scope: parsed.scope,
    state: parsed.state,
    ...(parsed.codeChallenge !== undefined && { codeChallenge: parsed.codeChallenge }),
    ...(parsed.codeChallengeMethod !== undefined && {
      codeChallengeMethod: parsed.codeChallengeMethod,
    }),
    ...(parsed.resource !== undefined && { resource: parsed.resource }),
    ...(parsed.issuer !== undefined && { issuer: parsed.issuer }),
  };
}

/** Extra styling on top of the shared shell, carrying the CSP nonce. */
function extraStyles(nonce: string): string {
  return `<style nonce="${escapeHtml(nonce)}">
.consent dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 6px 12px; font-size: 0.9rem; }
.consent dt { color: var(--text-dim); }
.consent dd { margin: 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.consent .row { display: flex; gap: 10px; }
.consent .row button { flex: 1; }
.consent button.deny { background: var(--bg-input); color: var(--text); }
.consent .warn { font-size: 0.85rem; }
</style>`;
}

function label(client: ClientInfo | null, clientId: string): string {
  const name = client?.clientName?.trim();
  return name !== undefined && name.length > 0 ? name : clientId;
}

/** The page itself. Text only: every value below comes from the client. */
function renderConsent(options: {
  nonce: string;
  request: AuthRequest;
  client: ClientInfo | null;
}): Response {
  const { request } = options;
  const scopes = request.scope.length > 0 ? request.scope.join(", ") : MCP_SCOPE;
  const body = `<main class="consent">
${extraStyles(options.nonce)}
<form method="post" action="/authorize">
  <h1>Authorise access</h1>
  <p>An MCP client is asking to read your health record through this server.</p>
  <dl>
    <dt>Client</dt><dd>${escapeHtml(label(options.client, request.clientId))}</dd>
    <dt>Client&nbsp;id</dt><dd>${escapeHtml(request.clientId)}</dd>
    <dt>Redirect&nbsp;to</dt><dd>${escapeHtml(request.redirectUri)}</dd>
    <dt>Scope</dt><dd>${escapeHtml(scopes)}</dd>
  </dl>
  <p class="warn">Approving grants read-only access to appointments, conditions,
  medications, results and documents from every connected health system, subject to
  your exposure policy. You can revoke it at any time from the MCP page.</p>
  <input type="hidden" name="oauth_req" value="${escapeHtml(encodeRequest(request))}">
  <div class="row">
    <button type="submit" name="decision" value="deny" class="deny">Deny</button>
    <button type="submit" name="decision" value="approve">Approve</button>
  </div>
</form>
</main>`;
  return htmlResponse(
    htmlPage({ title: "Healthy", nonce: options.nonce, body, bodyClass: "login" }),
    200,
  );
}

/** A refusal that is this Worker's fault to explain, not the client's to retry. */
function badRequest(nonce: string, message: string): Response {
  const body = `<main class="consent">
${extraStyles(nonce)}
<form>
  <h1>Cannot authorise</h1>
  <p class="error">${escapeHtml(message)}</p>
  <p>Start the connection again from the client that needs access.</p>
</form>
</main>`;
  return htmlResponse(htmlPage({ title: "Healthy", nonce, body, bodyClass: "login" }), 400);
}

/**
 * Only `http:` and `https:` may ever be navigated to.
 *
 * Defence in depth: both branches below already check the address against the
 * client's own registration, but a `javascript:` or `data:` URL that reached a
 * hand-off page would be script execution on this origin, so the scheme is
 * checked at the point of use as well.
 */
function isNavigable(location: string): boolean {
  try {
    const { protocol } = new URL(location);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * The hand-off back to the MCP client.
 *
 * A 200 page carrying `<meta http-equiv="refresh">`, NOT a 302 -- and that is not a
 * style choice. The global CSP sets `form-action 'self'`, and browsers apply
 * `form-action` to the redirect that a form POST is answered with: a 302 from
 * `POST /authorize` to the client's own callback (claude.ai's, say) is blocked, and
 * the connection silently never completes. Widening `form-action` to every
 * registered client's origin would weaken the policy for every other form in the
 * app, so the POST answers 200 and the browser navigates instead, which
 * `form-action` does not govern.
 *
 * The document is written out here rather than through `public/html.ts` because it
 * needs a `<meta>` in `<head>`, and a meta refresh in `<body>` is not reliably
 * honoured. The link is the no-JavaScript fallback, and it is the only thing on the
 * page a person would ever see.
 */
function handOff(nonce: string, location: string, heading: string): Response {
  const safe = escapeHtml(location);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="refresh" content="0;url=${safe}">
<title>Healthy</title>
<style nonce="${escapeHtml(nonce)}">
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
       margin: 0; padding: 15vh 20px; line-height: 1.6; text-align: center; }
h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
p { color: #5b6572; margin: 0 0 1rem; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(heading)}</h1>
<p>Returning you to the application that asked for access.</p>
<p><a href="${safe}">Continue</a></p>
</main>
</body>
</html>
`;
  return htmlResponse(html, 200);
}

/** GET /authorize: show what is being asked for. */
export async function consentPage(request: Request, env: Env, nonce: string): Promise<Response> {
  const helpers = oauthHelpers(env);
  let authRequest: AuthRequest;
  try {
    authRequest = await helpers.parseAuthRequest(request);
  } catch {
    // The library throws for a missing or unsupported response type, an
    // unregistered client, and an unresolvable CIMD client id. None of them can be
    // distinguished usefully for the owner, and echoing the library's message
    // would put a client-supplied string on the page.
    return badRequest(nonce, "That authorisation request is not valid or has expired.");
  }
  const client = await helpers.lookupClient(authRequest.clientId);
  return renderConsent({ nonce, request: authRequest, client });
}

/** True when `redirectUri` is one this client registered. Exact match, as OAuth requires. */
function redirectAllowed(client: ClientInfo | null, redirectUri: string): boolean {
  return client?.redirectUris.includes(redirectUri) === true;
}

/** The denial redirect: `error=access_denied`, with the client's state echoed back. */
function denialUrl(authRequest: AuthRequest): string | null {
  let url: URL;
  try {
    url = new URL(authRequest.redirectUri);
  } catch {
    return null;
  }
  url.searchParams.set("error", "access_denied");
  if (authRequest.state !== "") url.searchParams.set("state", authRequest.state);
  // RFC 9207: an error response carries the issuer too, when one was recorded.
  if (authRequest.issuer !== undefined) url.searchParams.set("iss", authRequest.issuer);
  return url.href;
}

async function completeApproval(
  helpers: OAuthHelpers,
  authRequest: AuthRequest,
  nonce: string,
): Promise<Response> {
  const at = toIso(nowSeconds());
  const { redirectTo } = await helpers.completeAuthorization({
    request: authRequest,
    userId: OWNER_USER_ID,
    metadata: { approvedAt: at },
    // The requested scope is ignored in favour of the only scope this server has.
    // A client that asked for more does not get more, and one that asked for
    // nothing still gets a usable grant.
    scope: [MCP_SCOPE],
    props: { grantedAt: at },
  });
  return isNavigable(redirectTo)
    ? handOff(nonce, redirectTo, "Access granted")
    : badRequest(nonce, "That client asked to return to an address that cannot be used.");
}

/** POST /authorize: approve or deny. */
export async function consentDecision(
  request: Request,
  env: Env,
  nonce: string,
): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return badRequest(nonce, "That form submission could not be read.");
  }

  const encoded = form.get("oauth_req");
  if (typeof encoded !== "string") {
    return badRequest(nonce, "That form submission was incomplete.");
  }

  const decision = form.get("decision");
  const authRequest = decodeRequest(encoded);
  if (authRequest === null) {
    return badRequest(nonce, "That authorisation request is not valid or has expired.");
  }

  const helpers = oauthHelpers(env);
  const client = await helpers.lookupClient(authRequest.clientId);
  // Re-validated on both branches. `completeAuthorization` checks this too, but the
  // denial branch builds its own redirect, and an unchecked redirect target there
  // would be an open redirect on the most trusted page in the app.
  if (!redirectAllowed(client, authRequest.redirectUri)) {
    return badRequest(
      nonce,
      "That client is not registered for the address it asked to return to.",
    );
  }

  if (decision !== "approve") {
    const denied = denialUrl(authRequest);
    return denied === null || !isNavigable(denied)
      ? badRequest(nonce, "That client asked to return to an address that cannot be used.")
      : handOff(nonce, denied, "Request denied");
  }

  return completeApproval(helpers, authRequest, nonce);
}
