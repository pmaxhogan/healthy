/**
 * `/api/mcp/policy` -- the exposure rules, the field tree they are built from,
 * and the two windows onto real data the rule builder uses.
 *
 * ### The sharp end
 *
 * `mcp_policy` is allow-all with a deny-list, enforced at one server-side choke
 * point before serialisation. These routes are the only way rules get in and
 * out, so a rule that is accepted here and never read there is a rule the owner
 * believes is protecting them. That is why a `field` rule is checked before it
 * is stored (`checkFieldSpec`): a path that names nothing in the rule's scope,
 * a tool that does not exist, a health system that does not exist -- each is a
 * 400 whose message says what is wrong, never a row that quietly does nothing.
 * Adding the same rule twice is a no-op that returns the existing row.
 *
 * ### Real data, owner's eyes only
 *
 * `POST /structure` and `POST /preview` run a real tool over the owner's cached
 * record (`worker/mcp/policy-sample.ts`). They are POSTs so the CSRF guard
 * covers them like every other route that does work; what they answer goes
 * only to the admin UI behind Access and the password session, and nothing of
 * it is logged or audited.
 */

import { Hono } from "hono";

import { formatPath } from "@shared/policy-path.ts";

import { AppError } from "../../lib/errors.ts";
import { adminCaller } from "../../mcp/admin-call.ts";
import { makeToolDeps } from "../../mcp/deps-d1.ts";
import { previewDraft, sampleStructure } from "../../mcp/policy-sample.ts";
import { TOOL_NAMES } from "../../mcp/tool-names.ts";
import { ALLOW_PREFIX, parseFieldTarget } from "../../policy/rules.ts";
import { policySchema } from "../../policy/tree.ts";
import { checkFieldSpec, fieldSignature } from "../../policy/validate.ts";
import { toPolicyRuleDto } from "../dto.ts";
import { NO_STORE, apiContext, readJson } from "../http.ts";
import {
  policyPreviewSchema,
  policyRuleSchema,
  policySampleSchema,
  updatePolicyRuleSchema,
} from "../schemas.ts";

import type { AppHonoEnv } from "../../auth/gate.ts";
import type { FieldRuleColumns } from "../../db/repos/mcp-policy.ts";
import type { ApiContext } from "../http.ts";
import type {
  CreatePolicyRuleRequest,
  FieldRuleSpec,
  PolicyPreviewDto,
  PolicySchemaDto,
  PolicyStructureDto,
  UpdatePolicyRuleRequest,
} from "@shared/types.ts";

export const mcpPolicyRouter = new Hono<AppHonoEnv>();

/** A legacy `[allow:]ResourceType.path` target as a structured rule, or a 400. */
function legacySpec(target: string): FieldRuleSpec {
  const allow = target.startsWith(ALLOW_PREFIX);
  const parsed = parseFieldTarget(allow ? target.slice(ALLOW_PREFIX.length) : target);
  if (parsed === null) {
    throw new AppError(
      "bad_request",
      "a field target has to be ResourceType.path.to.field (or allow:ResourceType.field)",
      { target },
    );
  }
  return {
    effect: allow ? "allow" : "hide",
    tool: null,
    resourceType: parsed.resourceType === "*" ? null : parsed.resourceType,
    healthSystemId: null,
    paths: [formatPath(parsed.path)],
  };
}

/** Check a `field` rule against the tree and the health systems, or throw a 400 saying why. */
async function checkedColumns(api: ApiContext, spec: FieldRuleSpec): Promise<FieldRuleColumns> {
  const healthSystems = await api.repos.healthSystems.list();
  const check = checkFieldSpec(spec, new Set(healthSystems.map((row) => row.id)));
  if (!check.ok) {
    throw new AppError("bad_request", check.issues.join(" "), { issues: check.issues });
  }
  return { target: fieldSignature(check.spec), ...check.spec };
}

function knownTool(tool: string): void {
  if (!(TOOL_NAMES as readonly string[]).includes(tool)) {
    throw new AppError("not_found", "no such MCP tool", { tool });
  }
}

mcpPolicyRouter.get("/", async (c) => {
  const api = apiContext(c);
  const rows = await api.repos.mcpPolicy.list();
  return c.json(
    rows.map((row) => toPolicyRuleDto(row)),
    200,
    NO_STORE,
  );
});

/** Static: the field tree. Cached by nothing but the Worker isolate. */
mcpPolicyRouter.get("/schema", (c) => c.json<PolicySchemaDto>(policySchema(), 200, NO_STORE));

mcpPolicyRouter.post("/", async (c) => {
  const api = apiContext(c);
  // Typed against the shared contract as well as the schema, so the SPA's payload
  // and the Worker's parser cannot drift apart without a compile error.
  const body: CreatePolicyRuleRequest = await readJson(c, policyRuleSchema);
  const enabled = body.enabled ?? true;
  if (body.ruleType === "field") {
    const spec = body.field ?? legacySpec(body.target ?? "");
    const row = await api.repos.mcpPolicy.addField(
      await checkedColumns(api, spec),
      body.note,
      enabled,
    );
    return c.json(toPolicyRuleDto(row), 201, NO_STORE);
  }
  const target = (body.target ?? "").trim();
  if (target === "") throw new AppError("bad_request", "the rule needs a target");
  const row = await api.repos.mcpPolicy.add(body.ruleType, target, body.note, enabled);
  return c.json(toPolicyRuleDto(row), 201, NO_STORE);
});

mcpPolicyRouter.patch("/:id", async (c) => {
  const api = apiContext(c);
  const id = c.req.param("id");
  const body: UpdatePolicyRuleRequest = await readJson(c, updatePolicyRuleSchema);
  const existing = await api.repos.mcpPolicy.byId(id);
  if (existing === null) throw new AppError("not_found", "no such policy rule");

  if (body.field !== undefined && existing.rule_type !== "field") {
    throw new AppError("bad_request", "only a field rule has fields");
  }
  if (body.target !== undefined && existing.rule_type === "field") {
    throw new AppError("bad_request", "a field rule is changed through `field`, not `target`");
  }
  const field = body.field === undefined ? undefined : await checkedColumns(api, body.field);
  const target = field?.target ?? body.target?.trim();
  if (target !== undefined) {
    const clash = await api.repos.mcpPolicy.get(existing.rule_type, target);
    if (clash !== null && clash.id !== id) {
      throw new AppError("conflict", "an identical rule already exists", { ruleId: clash.id });
    }
  }
  const row = await api.repos.mcpPolicy.update(id, {
    enabled: body.enabled,
    note: body.note === undefined ? undefined : (body.note?.trim() ?? "") || null,
    target: field === undefined ? target : undefined,
    field,
  });
  if (row === null) throw new AppError("not_found", "no such policy rule");
  return c.json(toPolicyRuleDto(row), 200, NO_STORE);
});

mcpPolicyRouter.delete("/:id", async (c) => {
  const api = apiContext(c);
  const removed = await api.repos.mcpPolicy.remove(c.req.param("id"));
  if (!removed) throw new AppError("not_found", "no such policy rule");
  return c.json({ ok: true }, 200, NO_STORE);
});

/** The key structure of one tool's real answer: names only, never a value. */
mcpPolicyRouter.post("/structure", async (c) => {
  const body = await readJson(c, policySampleSchema);
  knownTool(body.tool);
  const deps = makeToolDeps({ env: c.env, caller: adminCaller() });
  const structure = await sampleStructure(deps, body.tool, body.resourceType);
  if (structure === null) throw new AppError("bad_request", "that tool could not be sampled");
  return c.json<PolicyStructureDto>(structure, 200, NO_STORE);
});

/**
 * A draft `field` rule run over one tool's real answer. Doubles as live
 * validation: a draft that would be refused on save is refused here with the
 * same sentence.
 */
mcpPolicyRouter.post("/preview", async (c) => {
  const api = apiContext(c);
  const body = await readJson(c, policyPreviewSchema);
  knownTool(body.tool);
  const columns = await checkedColumns(api, body.field);
  const deps = makeToolDeps({ env: c.env, caller: adminCaller() });
  const preview = await previewDraft(deps, await api.repos.mcpPolicy.list(), {
    tool: body.tool,
    resourceType: body.resourceType,
    field: { ...columns, paths: [...columns.paths] },
  });
  if (preview === null) throw new AppError("bad_request", "that tool could not be sampled");
  return c.json<PolicyPreviewDto>(preview, 200, NO_STORE);
});
