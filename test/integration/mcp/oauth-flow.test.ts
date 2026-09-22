// The whole OAuth dance, for real, and then a real MCP call over the bearer it
// produces.
//
// This is the test that proves a claude.ai connector can actually work:
//
//   1. Dynamic Client Registration, because claude.ai registers itself and sends
//      a blank client id.
//   2. The consent page, behind the owner's password session, with PKCE S256.
//   3. The token endpoint, exchanging the code for an access token.
//   4. `POST /mcp` with that token, through the Durable Object, initializing a
//      session and calling a tool.
//   5. The audit row, which must carry the real client id and grant id -- they are
//      stamped in by the token-exchange callback, and this is the only place that
//      can be observed end to end.
//
// `SELF` and `app.fetch` are both used on purpose: the provider's endpoints need
// the real Worker entry point, while the consent page needs DEV_MODE on so the
// Access half of the gate is relaxed. Both share the same D1 and the same
// OAUTH_KV, so they are two doors into one deployment rather than two deployments.

import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { app } from "../../../worker/app.ts";
import { MIN_PBKDF2_ITERATIONS, hashPassword } from "../../../worker/auth/password.ts";
import { makeCtx } from "../../../worker/db/client.ts";
import { makeRepos } from "../../../worker/db/index.ts";
import { listGrants, revokeGrant } from "../../../worker/mcp/grants.ts";

import type { Repos } from "../../../worker/db/index.ts";
import type { Env } from "../../../worker/env.ts";

const ORIGIN = "https://healthy.example";
const PASSWORD = "the-owners-password";
/** The address claude.ai always comes back to. */
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const PROVIDER_NAME = "Example Health";

const GATED_ENV = {
  ...env,
  DEV_MODE: "true",
  PASSWORD_HASH: await hashPassword(PASSWORD, MIN_PBKDF2_ITERATIONS),
  SESSION_SECRET: "integration-test-signing-material",
} as unknown as Env;

function repos(): Repos {
  return makeRepos(makeCtx(env.DB, GATED_ENV));
}

async function gated(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(ORIGIN + path, init), GATED_ENV, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function sessionCookie(): Promise<string> {
  const form = new FormData();
  form.set("password", PASSWORD);
  const response = await gated("/auth/login", {
    method: "POST",
    headers: { origin: ORIGIN },
    body: form,
  });
  return (response.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** A PKCE verifier and its S256 challenge; `plain` is refused by configuration. */
async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** Register a client the way claude.ai does: public, one fixed redirect. */
async function register(clientName: string): Promise<string> {
  const response = await SELF.fetch(`${ORIGIN}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const body = await response.json<{ client_id?: string }>();
  expect(response.status, JSON.stringify(body)).toBeLessThan(300);
  expect(typeof body.client_id).toBe("string");
  return body.client_id ?? "";
}

/** The hidden `oauth_req` field out of the rendered consent page. */
function hiddenRequest(html: string): string {
  const match = /name="oauth_req" value="([^"]+)"/u.exec(html);
  expect(match, "consent page did not carry an oauth_req field").not.toBeNull();
  return unescapeHtml(match?.[1] ?? "");
}

function unescapeHtml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

/**
 * Where the hand-off page sends the browser.
 *
 * The decision is answered with a 200 and a meta refresh rather than a 302, because
 * the global CSP's `form-action 'self'` would have the browser block a redirect
 * that a form POST was answered with. Asserting on the page (and not on a
 * `location` header) is asserting on the behaviour that actually ships.
 */
function handOffTarget(html: string): URL {
  const meta = /<meta http-equiv="refresh" content="0;url=([^"]+)">/u.exec(html);
  expect(meta, "decision did not answer with a hand-off page").not.toBeNull();
  const link = /<a href="([^"]+)">/u.exec(html);
  // The no-JavaScript fallback must go to the same place as the refresh.
  expect(link?.[1]).toBe(meta?.[1]);
  return new URL(unescapeHtml(meta?.[1] ?? ""));
}

interface Approved {
  code: string;
  clientId: string;
  verifier: string;
}

/** Register, consent, approve, and come back with an authorization code. */
async function approve(clientName = "Test Connector"): Promise<Approved> {
  const clientId = await register(clientName);
  const { verifier, challenge } = await pkce();
  const cookie = await sessionCookie();

  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "health:read",
    state: "client-state-123",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  const page = await gated(`/authorize?${query.toString()}`, { headers: { cookie } });
  const html = await page.text();
  expect(page.status, html.slice(0, 400)).toBe(200);
  expect(html).toContain(clientName);
  expect(html).toContain(REDIRECT_URI);

  const form = new URLSearchParams({ oauth_req: hiddenRequest(html), decision: "approve" });
  const decided = await gated("/authorize", {
    method: "POST",
    headers: {
      origin: ORIGIN,
      cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  const decidedHtml = await decided.text();

  expect(decided.status, decidedHtml.slice(0, 400)).toBe(200);
  expect(decided.headers.get("content-type")).toContain("text/html");
  // No 302: see handOffTarget. A `location` header here would be the bug.
  expect(decided.headers.get("location")).toBeNull();

  const location = handOffTarget(decidedHtml);
  expect(location.origin + location.pathname).toBe(REDIRECT_URI);
  expect(location.searchParams.get("state")).toBe("client-state-123");
  const code = location.searchParams.get("code") ?? "";
  expect(code).not.toBe("");

  return { code, clientId, verifier };
}

/** Exchange the code for an access token at the provider's own endpoint. */
interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
}

async function exchangeTokens(approved: Approved): Promise<TokenResponse> {
  const response = await SELF.fetch(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: approved.code,
      redirect_uri: REDIRECT_URI,
      client_id: approved.clientId,
      code_verifier: approved.verifier,
    }).toString(),
  });
  const body = await response.json<TokenResponse>();

  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body.scope).toBe("health:read");
  return body;
}

async function exchange(approved: Approved): Promise<string> {
  const body = await exchangeTokens(approved);
  return body.access_token ?? "";
}

/** Redeem a refresh token, as a client does once the hour is up. */
async function refresh(refreshToken: string, clientId: string): Promise<TokenResponse> {
  const response = await SELF.fetch(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }).toString(),
  });
  const body = await response.json<TokenResponse>();

  expect(response.status, JSON.stringify(body)).toBe(200);
  return body;
}

/** Initialize a session and call one tool. Returns nothing; assert on the audit. */
async function callOverBearer(token: string, tool: string): Promise<void> {
  const initialized = await rpc(token, INITIALIZE);
  expect(initialized.response.status).toBe(200);
  const sessionId = initialized.response.headers.get("mcp-session-id") ?? undefined;
  await rpc(token, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  const called = await rpc(
    token,
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: tool, arguments: {} } },
    sessionId,
  );
  const content =
    (called.result?.result as { content?: { text?: string }[] } | undefined)?.content ?? [];
  expect(content[0]?.text).toContain(PROVIDER_NAME);
}

/** One JSON-RPC message over Streamable HTTP, with the SSE framing unwrapped. */
async function rpc(
  token: string,
  message: Record<string, unknown>,
  sessionId?: string,
): Promise<{ response: Response; result: Record<string, unknown> | null }> {
  const response = await SELF.fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId !== undefined && { "mcp-session-id": sessionId }),
    },
    body: JSON.stringify(message),
  });
  const text = await response.text();
  if (text.trim() === "") return { response, result: null };
  // Streamable HTTP may answer with a JSON body or an SSE stream carrying one
  // `data:` line per message; both are valid and the transport picks.
  const payload = text.includes("data:") ? (/^data: (.*)$/mu.exec(text)?.[1] ?? "null") : text;
  return { response, result: JSON.parse(payload) as Record<string, unknown> | null };
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-connector", version: "1" },
  },
};

/**
 * One synthetic provider, so a tool call has something to return.
 *
 * Deliberately NOT a cached FHIR resource. The tool call below runs inside the
 * Durable Object, which sees the deployment's own `env` -- and `DATA_KEY` is a
 * secret that a clean CI checkout does not have, so anything sealed would be
 * unreadable there. `providers.display_name` is plaintext by design (it is not
 * personal data on its own), so `list_providers` is the tool that exercises the
 * whole path without depending on a key this test cannot inject. The encrypted
 * read path is covered in `tools.test.ts`, which builds its own env and its own key.
 */
beforeAll(async () => {
  await repos().providers.create({
    vendor: "epic",
    displayName: PROVIDER_NAME,
    fhirBaseUrl: "https://a.fhir.example.test/R4",
    environment: "sandbox",
  });
});

describe("dynamic client registration", () => {
  it("accepts a public client with claude.ai's fixed redirect URI", async () => {
    const clientId = await register("Registration Only");

    expect(clientId).not.toBe("");
  });
});

describe("the consent page", () => {
  it("shows the client, the redirect and the scope, and mints a code on approve", async () => {
    const approved = await approve("Consent Connector");

    expect(approved.code).not.toBe("");
  });

  it("redirects with error=access_denied on deny, and issues no code", async () => {
    const clientId = await register("Denied Connector");
    const { challenge } = await pkce();
    const cookie = await sessionCookie();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: "health:read",
      state: "denied-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    const page = await gated(`/authorize?${query.toString()}`, { headers: { cookie } });
    const html = await page.text();
    const decided = await gated("/authorize", {
      method: "POST",
      headers: { origin: ORIGIN, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        oauth_req: hiddenRequest(html),
        decision: "deny",
      }).toString(),
    });
    const decidedHtml = await decided.text();
    const location = handOffTarget(decidedHtml);

    expect(decided.status).toBe(200);
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("denied-state");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("answers the approval with a navigable page, not a blocked form redirect", async () => {
    // Regression guard for the CSP interaction: the global policy sets
    // `form-action 'self'`, which browsers apply to the redirect that answers a
    // form POST. A 302 to the client's own callback would be blocked and the
    // connection would silently never complete.
    const approved = await approve("Handoff Connector");

    expect(approved.code).not.toBe("");
  });

  it("refuses a redirect URI the client did not register", async () => {
    const clientId = await register("Tampering Connector");
    const cookie = await sessionCookie();
    const tampered = btoa(
      JSON.stringify({
        responseType: "code",
        clientId,
        redirectUri: "https://evil.example/steal",
        scope: ["health:read"],
        state: "s",
      }),
    );

    const decided = await gated("/authorize", {
      method: "POST",
      headers: { origin: ORIGIN, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ oauth_req: tampered, decision: "approve" }).toString(),
    });
    const html = await decided.text();

    expect(decided.status).toBe(400);
    expect(decided.headers.get("location")).toBeNull();
    // Neither as a redirect nor as a hand-off link: an unregistered address must
    // not become a navigation target on this page at all.
    expect(html).not.toContain("evil.example");
  });
});

describe("the token endpoint", () => {
  it("exchanges the code for a token scoped to health:read", async () => {
    const token = await exchange(await approve("Token Connector"));

    expect(token).not.toBe("");
  });

  it("refuses to reuse an authorization code", async () => {
    const approved = await approve("Replay Connector");
    await exchange(approved);

    const second = await SELF.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: approved.code,
        redirect_uri: REDIRECT_URI,
        client_id: approved.clientId,
        code_verifier: approved.verifier,
      }).toString(),
    });
    await second.text();

    expect(second.status).toBeGreaterThanOrEqual(400);
  });

  it("refuses the wrong PKCE verifier", async () => {
    const approved = await approve("Wrong Verifier Connector");

    const response = await SELF.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: approved.code,
        redirect_uri: REDIRECT_URI,
        client_id: approved.clientId,
        code_verifier: "not-the-verifier",
      }).toString(),
    });
    await response.text();

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe("a real MCP session over the issued bearer", () => {
  it("initializes, lists tools, calls one, and audits the real client and grant", async () => {
    const approved = await approve("Session Connector");
    const token = await exchange(approved);

    const initialized = await rpc(token, INITIALIZE);
    expect(initialized.response.status).toBe(200);
    const sessionId = initialized.response.headers.get("mcp-session-id") ?? undefined;
    expect(sessionId).toBeDefined();
    expect(
      (initialized.result?.result as { serverInfo?: { name?: string } } | undefined)?.serverInfo
        ?.name,
    ).toBe("Healthy");

    await rpc(token, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);

    const listed = await rpc(token, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sessionId);
    const tools =
      (listed.result?.result as { tools?: { name: string }[] } | undefined)?.tools ?? [];
    expect(tools.length).toBeGreaterThan(20);
    expect(tools.map((tool) => tool.name)).toContain("get_health_summary");

    const called = await rpc(
      token,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_providers", arguments: {} },
      },
      sessionId,
    );
    const content =
      (called.result?.result as { content?: { text?: string }[] } | undefined)?.content ?? [];
    expect(content[0]?.text).toContain(PROVIDER_NAME);

    // The point of the whole file: the audit row names the client and the grant
    // that were actually issued, which only the token-exchange callback can supply.
    const rows = await repos().mcpAudit.listRecent(20);
    const row = rows.find((entry) => entry.tool === "list_providers");
    expect(row?.clientId).toBe(approved.clientId);
    expect(row?.grantId).not.toBeNull();
    expect(row?.ok).toBe(true);
  });

  it("keeps the caller identity on a token minted by a refresh", async () => {
    // The client and grant ids reach the audit row through the token-exchange
    // callback. If that callback did not also fire on `grant_type=refresh_token`,
    // every row after the first hour would have a null caller -- and nothing in a
    // four-second test would notice.
    const approved = await approve("Refreshing Connector");
    const first = await exchangeTokens(approved);
    expect(first.refresh_token ?? "").not.toBe("");

    const second = await refresh(first.refresh_token ?? "", approved.clientId);
    expect(second.access_token ?? "").not.toBe("");
    expect(second.access_token).not.toBe(first.access_token);

    await callOverBearer(second.access_token ?? "", "list_providers");

    const rows = await repos().mcpAudit.listRecent(50);
    const row = rows.find(
      (entry) => entry.tool === "list_providers" && entry.clientId === approved.clientId,
    );
    expect(row?.clientId).toBe(approved.clientId);
    expect(row?.grantId).not.toBeNull();
    expect(row?.ok).toBe(true);
  });

  it("refuses a request whose session id was never initialized", async () => {
    const token = await exchange(await approve("Stray Session Connector"));

    const strayed = await rpc(
      token,
      { jsonrpc: "2.0", id: 9, method: "tools/list" },
      "streamable-http:never-seen",
    );

    expect(strayed.response.status).toBeGreaterThanOrEqual(400);
  });
});

describe("the grant helpers the admin API calls", () => {
  it("lists a grant with its client name and revokes it", async () => {
    const approved = await approve("Revocable Connector");
    await exchange(approved);

    const before = await listGrants(GATED_ENV);
    const mine = before.find((grant) => grant.clientId === approved.clientId);
    expect(mine?.clientName).toBe("Revocable Connector");
    expect(mine?.scope).toStrictEqual(["health:read"]);
    expect(Date.parse(mine?.createdAt ?? "")).not.toBeNaN();

    expect(await revokeGrant(GATED_ENV, mine?.id ?? "")).toBe(true);

    const after = await listGrants(GATED_ENV);
    expect(after.some((grant) => grant.id === mine?.id)).toBe(false);
  });

  it("reports false for a grant id that does not exist", async () => {
    expect(await revokeGrant(GATED_ENV, "no-such-grant")).toBe(false);
  });

  it("dates a grant's last use from the audit trail", async () => {
    const approved = await approve("Used Connector");
    const token = await exchange(approved);
    const initialized = await rpc(token, INITIALIZE);
    const sessionId = initialized.response.headers.get("mcp-session-id") ?? undefined;
    await rpc(token, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
    await rpc(
      token,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "list_providers", arguments: {} },
      },
      sessionId,
    );

    const grants = await listGrants(GATED_ENV);
    const mine = grants.find((grant) => grant.clientId === approved.clientId);

    expect(mine?.lastUsedAt).not.toBeNull();
  });
});
