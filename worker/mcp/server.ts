// Placeholder for the MCP server.
//
// TODO(wave2): replace this class body with `McpAgent` from `agents/mcp`, the
// tool registrations, and the policy choke point. The class NAME and the
// SQLite-backed Durable Object migration (`new_sqlite_classes: ["HealthyMcp"]`
// in wrangler.jsonc, tag v1) must survive that change untouched: renaming a
// Durable Object class after it has been deployed means a new migration and an
// orphaned namespace, so the stub is deliberately named its final name.
//
// It stays a bare DurableObject for now so the migration is valid and
// deployable on day one, and so `wrangler deploy` never has to be run against
// a half-written agent.

import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env.ts";

export class HealthyMcp extends DurableObject<Env> {
  override fetch(): Response {
    // TODO(wave2): McpAgent.serve("/mcp") handles this instead, mounted as the
    // OAuthProvider's apiHandler.
    return Response.json({ error: "mcp_not_implemented" }, { status: 501 });
  }
}
