/**
 * `/api/mcp` -- the exposure deny-list, the granted clients, and the audit trail.
 *
 * ### The policy routes are the sharp end
 *
 * `mcp_policy` is allow-all with a deny-list, enforced at one server-side choke
 * point before serialisation. These routes are the only way rules get in and out,
 * so a rule that is accepted here and never read there is a rule the owner
 * believes is protecting them. `ruleType` is therefore a closed enum matching the
 * column's CHECK, and adding the same rule twice is a no-op that returns the
 * existing row -- the UI can be fire and forget.
 *
 * ### Grants come from somebody else's store
 *
 * MCP grants live in `@cloudflare/workers-oauth-provider`'s KV namespace, not in
 * D1, so they are reached through a port (`worker/api/ports.ts`). Listing them can
 * fail independently of everything else, which is why `GET /api/overview` reports
 * a grant count of zero rather than failing outright when the store is unreachable.
 */

import { Hono } from "hono";

import { AppError } from "../../lib/errors.ts";
import { ALLOW_PREFIX, fieldRuleResolves, parseFieldTarget } from "../../policy/rules.ts";
import { toAuditDto, toPolicyRuleDto } from "../dto.ts";
import { NO_STORE, apiContext, limitQuerySchema, readJson, readQuery } from "../http.ts";
import { policyRuleSchema } from "../schemas.ts";
import { TOOL_CATALOG } from "../tool-catalog.ts";

import type { AppHonoEnv } from "../../auth/gate.ts";
import type { GrantLike } from "../ports.ts";
import type { CreatePolicyRuleRequest, McpGrantDto } from "@shared/types.ts";

/** Audit rows per page when the caller does not say. */
const DEFAULT_AUDIT_LIMIT = 100;

export const mcpRouter = new Hono<AppHonoEnv>();

// --- policy ----------------------------------------------------------------

mcpRouter.get("/policy", async (c) => {
  const api = apiContext(c);
  const rows = await api.repos.mcpPolicy.list();
  return c.json(
    rows.map((row) => toPolicyRuleDto(row)),
    200,
    NO_STORE,
  );
});

mcpRouter.post("/policy", async (c) => {
  const api = apiContext(c);
  // Typed against the shared contract as well as the schema, so the SPA's payload
  // and the Worker's parser cannot drift apart without a compile error.
  const body: CreatePolicyRuleRequest = await readJson(c, policyRuleSchema);
  // A `field` target that names nothing in either vocabulary is refused outright
  // rather than stored as `unparsed`: it parses fine (it is a real dotted path
  // below a real resource type), so the admin UI's typo signal never fires, and
  // the owner would otherwise have no way to discover a rule that can never
  // remove anything. A target that fails to parse at all -- `parseFieldTarget`
  // returning `null` -- is unaffected; that is still reported via `unparsed`,
  // as before, not rejected here.
  if (body.ruleType === "field" && !body.target.startsWith(ALLOW_PREFIX)) {
    const rule = parseFieldTarget(body.target);
    if (rule !== null && !fieldRuleResolves(rule)) {
      throw new AppError(
        "bad_request",
        "field rule matches nothing in either the normalized or the raw FHIR vocabulary",
        { target: body.target },
      );
    }
  }
  const row = await api.repos.mcpPolicy.add(body.ruleType, body.target, body.note);
  return c.json(toPolicyRuleDto(row), 201, NO_STORE);
});

mcpRouter.delete("/policy/:id", async (c) => {
  const api = apiContext(c);
  const removed = await api.repos.mcpPolicy.remove(c.req.param("id"));
  if (!removed) throw new AppError("not_found", "no such policy rule");
  return c.json({ ok: true }, 200, NO_STORE);
});

// --- grants ----------------------------------------------------------------

/** The epoch, for a grant whose store did not record when it was created. */
const UNKNOWN_CREATED_AT = new Date(0).toISOString();

/**
 * Project one grant record.
 *
 * Defensive because the shape ultimately belongs to a dependency that has changed
 * it between releases: a missing `createdAt` becomes the epoch rather than
 * `Invalid Date`, and a missing client id is named `unknown` rather than left blank.
 */
function toGrantDto(raw: GrantLike): McpGrantDto {
  return {
    id: raw.id,
    clientId: raw.clientId ?? "unknown",
    clientName: raw.clientName ?? null,
    scope: [...(raw.scope ?? [])],
    createdAt: raw.createdAt ?? UNKNOWN_CREATED_AT,
    lastUsedAt: raw.lastUsedAt ?? null,
  };
}

mcpRouter.get("/grants", async (c) => {
  const api = apiContext(c);
  const grants = await api.ports.grants.listGrants(c.env);
  return c.json(
    grants.map((grant) => toGrantDto(grant)),
    200,
    NO_STORE,
  );
});

mcpRouter.delete("/grants/:id", async (c) => {
  const api = apiContext(c);
  const revoked = await api.ports.grants.revokeGrant(c.env, c.req.param("id"));
  if (!revoked) throw new AppError("not_found", "no such grant");
  return c.json({ ok: true }, 200, NO_STORE);
});

// --- audit and the tool catalogue ------------------------------------------

mcpRouter.get("/audit", async (c) => {
  const api = apiContext(c);
  const { limit } = readQuery(c, limitQuerySchema);
  const entries = await api.repos.mcpAudit.listRecent(limit ?? DEFAULT_AUDIT_LIMIT);
  return c.json(
    entries.map((entry) => toAuditDto(entry)),
    200,
    NO_STORE,
  );
});

/** Static: see the note at the top of `worker/api/tool-catalog.ts`. */
mcpRouter.get("/tools", (c) => c.json([...TOOL_CATALOG], 200, NO_STORE));
