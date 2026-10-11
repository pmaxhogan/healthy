/**
 * Listing and revoking MCP grants, for the admin API.
 *
 * A grant is the thing that matters operationally: it is what a client holds, it
 * is what survives a token expiring, and revoking it is the one action that takes
 * a connector's access away immediately. The admin UI's "MCP" page is built on
 * these two functions:
 *
 *   GET    /api/mcp/grants       -> listGrants(env)
 *   DELETE /api/mcp/grants/:id   -> revokeGrant(env, id)
 *
 * Grants live in `OAUTH_KV`, not in D1, so they are read through the OAuth
 * library's helpers rather than a repo. `lastUsedAt` is the exception: the library
 * does not record it, so it is derived from the `mcp_audit` table, which is the
 * only place that knows a grant was actually used.
 */

import { reposFor } from "../db/index.ts";
import { toIso } from "../lib/time.ts";

import { OWNER_USER_ID, oauthHelpers } from "./oauth-config.ts";

import type { Env } from "../env.ts";
import type { GrantSummary, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { McpGrantDto } from "@shared/types.ts";

/** Grants per page when walking the KV listing. The library caps this at 1000. */
const PAGE_SIZE = 100;

/**
 * Audit rows scanned to date a grant's last use.
 *
 * Bounded deliberately: this is a display field on an admin page, and a grant that
 * has not been used in the last few hundred calls is one whose exact last-use time
 * nobody is making a decision on.
 */
const AUDIT_SCAN = 500;

/** Every grant the owner has issued, newest first. */
async function allGrants(helpers: OAuthHelpers): Promise<GrantSummary[]> {
  const out: GrantSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await helpers.listUserGrants(OWNER_USER_ID, {
      limit: PAGE_SIZE,
      ...(cursor !== undefined && { cursor }),
    });
    out.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return out;
}

/** The most recent audited call per grant id, in unix seconds. */
async function lastUsedByGrant(env: Env): Promise<Map<string, number>> {
  const repos = reposFor(env.DB, env);
  const rows = await repos.mcpAudit.listRecent(AUDIT_SCAN);
  const out = new Map<string, number>();
  // `listRecent` is newest-first, so the first row seen for a grant is its latest.
  for (const row of rows) {
    if (row.grantId !== null && !out.has(row.grantId)) out.set(row.grantId, row.ts);
  }
  return out;
}

/**
 * The grants, ready for the admin API to serialise.
 *
 * The client's display name comes from its registration, which is a client-supplied
 * string: the SPA must render it as text, never as markup. Nothing here trusts it
 * beyond passing it along.
 */
export async function listGrants(env: Env): Promise<McpGrantDto[]> {
  const helpers = oauthHelpers(env);
  const [grants, lastUsed] = await Promise.all([allGrants(helpers), lastUsedByGrant(env)]);

  const names = new Map<string, string | null>();
  const nameOf = async (clientId: string): Promise<string | null> => {
    const cached = names.get(clientId);
    if (cached !== undefined) return cached;
    const client = await helpers.lookupClient(clientId);
    const name = client?.clientName ?? null;
    names.set(clientId, name);
    return name;
  };

  const out: McpGrantDto[] = [];
  for (const grant of grants) {
    const used = lastUsed.get(grant.id);
    out.push({
      id: grant.id,
      clientId: grant.clientId,
      clientName: await nameOf(grant.clientId),
      scope: grant.scope,
      createdAt: toIso(grant.createdAt),
      lastUsedAt: used === undefined ? null : toIso(used),
    });
  }
  return out;
}

/**
 * Revoke one grant. False when there was no such grant to revoke.
 *
 * The existence check is what lets the admin API answer 404 rather than a silent
 * 204 for an id that was already gone -- the library's `revokeGrant` is idempotent
 * and does not say which it was.
 */
export async function revokeGrant(env: Env, grantId: string): Promise<boolean> {
  const helpers = oauthHelpers(env);
  const grants = await allGrants(helpers);
  if (grants.every((grant) => grant.id !== grantId)) return false;
  await helpers.revokeGrant(grantId, OWNER_USER_ID);
  return true;
}
