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
import { adminCaller, callMcpTool, listMcpTools } from "../../mcp/admin-call.ts";
import { makeToolDeps } from "../../mcp/deps-d1.ts";
import { toAuditDto } from "../dto.ts";
import { NO_STORE, apiContext, limitQuerySchema, readOptionalJson, readQuery } from "../http.ts";
import { mcpToolCallArgsSchema } from "../schemas.ts";
import { TOOL_CATALOG } from "../tool-catalog.ts";

import { mcpPolicyRouter } from "./mcp-policy.ts";

import type { AppHonoEnv } from "../../auth/gate.ts";
import type { GrantLike } from "../ports.ts";
import type { McpGrantDto, McpToolCallResponse, McpToolSchemaDto } from "@shared/types.ts";

/** Audit rows per page when the caller does not say. */
const DEFAULT_AUDIT_LIMIT = 100;

export const mcpRouter = new Hono<AppHonoEnv>();

// --- policy ----------------------------------------------------------------
//
// Its own module: the rules, the field tree, and the structure and preview
// windows onto real data. See `mcp-policy.ts`.

mcpRouter.route("/policy", mcpPolicyRouter);

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

// --- the admin console's own tool caller ------------------------------------
//
// Both routes below go through `worker/mcp/admin-call.ts`, which connects a real
// McpServer (the real `registerTools`, the real zod schemas, the real exposure
// policy, the real audit wrapper) to the SDK's own in-memory transport. Nothing
// here re-validates an argument or re-applies a policy rule; see that module's
// header for why that is the point.

/**
 * Every tool's real, live JSON input schema -- for the "Try a tool" panel's
 * picker and its argument editor's skeleton and validation. Distinct from
 * `GET /api/mcp/tools`: that one is the hand-maintained FHIR-resource-type index
 * policy targets are written against, and has no schema to give.
 */
mcpRouter.get("/tools/schema", async (c) => {
  const deps = makeToolDeps({ env: c.env, caller: adminCaller() });
  const tools = await listMcpTools(deps);
  return c.json<McpToolSchemaDto[]>(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    200,
    NO_STORE,
  );
});

/**
 * Call one tool as the admin console, not an OAuth client -- `adminCaller()` is
 * what `mcp_audit.client_id` reads for a call made from here.
 *
 * A `CallToolResult` that is real tool output is always the JSON envelope
 * `respond()`/`toolError()` serialise (`worker/mcp/respond.ts`): `{ items, ... }`
 * on success, `{ error, message, ... }` on a tool-level failure such as
 * `policy_denied` or `jq_error` (whose `detail` is jq's own message). Both are audited, because the tool ran either way, and both
 * are reported here as one 200 -- the caller's fault ends where the tool starts.
 *
 * A `CallToolResult` whose text does NOT parse as JSON never reached the tool at
 * all: it is the MCP SDK's own plain-English rejection of `args` against the
 * real input schema, thrown before `withAudit` runs (so there is no audit row for
 * it either). That is the caller's fault, and is answered as a 400 instead.
 */
mcpRouter.post("/tools/:name/call", async (c) => {
  const name = c.req.param("name");
  const args = await readOptionalJson(c, mcpToolCallArgsSchema);
  const deps = makeToolDeps({ env: c.env, caller: adminCaller() });

  const startedMs = Date.now();
  const result = await callMcpTool(deps, name, args);
  if (result === null) throw new AppError("not_found", "no such MCP tool", { tool: name });
  const durationMs = Date.now() - startedMs;

  const first = result.content[0];
  const text = first?.type === "text" ? first.text : "";
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AppError("bad_request", "the arguments did not match the tool's input schema", {
      issues: [text],
    });
  }

  return c.json<McpToolCallResponse>(
    {
      request: { name, arguments: args },
      result: { isError: result.isError === true, data },
      durationMs,
    },
    200,
    NO_STORE,
  );
});
