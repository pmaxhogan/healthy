/**
 * The exposure deny-list, parsed.
 *
 * `mcp_policy` rows are parsed once per MCP request into the shape
 * {@link applyPolicy} can enforce without re-parsing, and a row that parses to
 * nothing is reported rather than silently ignored.
 *
 * The model is allow-all with a deny-list, in four kinds:
 *
 *   `tool`           the tool name. A denied tool answers `policy_denied` and
 *                    reads nothing at all.
 *   `resource`       a FHIR resource type. Items of that type are dropped from
 *                    every tool's output, the raw projection and the summary.
 *   `health_system`  a health system id. The health system disappears
 *                    everywhere, `list_health_systems` included, and is never
 *                    even queried.
 *   `field`          one or more paths (`shared/policy-path.ts`), removed from
 *                    every item the rule's scope reaches, in the normalized item
 *                    AND the raw resource behind it. The scope is a tool, a
 *                    resource type, a health system, any combination of the
 *                    three, or none of them (every item of every tool).
 *
 * A `field` rule's effect is `hide` -- or `allow`, the one kind of rule that
 * adds rather than removes: fields an item names in its own `sensitive` array
 * (birth date, subscriber id) are withheld by DEFAULT, and an `allow` rule for
 * `birthDate` on Patient is how the owner puts it back. Nothing else can widen
 * exposure.
 *
 * A disabled row (`enabled = 0`) is skipped here, so it enforces nothing and
 * the admin UI can switch it back on without retyping it.
 *
 * Rows written before migration 0012 carry a `field` rule as one string,
 * `ResourceType.path` (or `allow:ResourceType.field`) with no `paths_json`. The
 * migration converts them; the legacy parser below still reads one, so a row
 * written by an older Worker mid-deploy is enforced rather than dropped.
 */

import { ARRAY_SEGMENT, formatPath, parsePath } from "@shared/policy-path.ts";

import type { McpPolicyRow } from "../db/rows.ts";
import type { FieldRuleSpec } from "@shared/types.ts";

export { ARRAY_SEGMENT } from "@shared/policy-path.ts";

/** Marks a legacy field target that re-enables a `sensitive` field rather than denying one. */
export const ALLOW_PREFIX = "allow:";

/** What a `field` rule does to the paths it names. */
type FieldEffect = "hide" | "allow";

/** One path of one `field` rule, with the scope it applies in. */
export interface FieldRule {
  /** The tool it applies to, or null for every tool. */
  tool: string | null;
  /** The resource type it applies to, or null for every type. */
  resourceType: string | null;
  /** The health system it applies to, or null for every health system. */
  healthSystemId: string | null;
  /** Path below the item root. `[]` steps into every element of an array. */
  path: readonly string[];
  /** The path in its canonical spelling, for the warning that says what was removed. */
  display: string;
}

/** Everything the filter needs, parsed once per request. */
export interface PolicyRules {
  /** Tool names that answer `policy_denied`. */
  tools: ReadonlySet<string>;
  /** FHIR resource types that never appear in any output. */
  resources: ReadonlySet<string>;
  /** Health system ids that are never read from and never listed. */
  healthSystems: ReadonlySet<string>;
  /** Paths removed from the items (and raw resources) their scope reaches. */
  fields: readonly FieldRule[];
  /** `sensitive` fields the owner has explicitly put back, each in its scope. */
  allows: readonly FieldRule[];
  /** Targets that parsed to nothing, so the admin UI can be told. */
  unparsed: readonly string[];
}

/** No rules at all: everything is exposed. The posture on a fresh database. */
export const EMPTY_RULES: PolicyRules = {
  tools: new Set(),
  resources: new Set(),
  healthSystems: new Set(),
  fields: [],
  allows: [],
  unparsed: [],
};

/**
 * The shape of an `mcp_policy` row this module reads. The 0012 columns are
 * optional so a test (or a pre-0012 row) can be just `{ rule_type, target }`.
 */
export type PolicyRuleInput = Pick<McpPolicyRow, "rule_type" | "target"> &
  Partial<
    Pick<
      McpPolicyRow,
      "enabled" | "effect" | "scope_tool" | "scope_resource" | "scope_health_system" | "paths_json"
    >
  >;

/** Where one item sits, for deciding which scoped rules reach it. */
export interface ItemScope {
  tool: string;
  resourceType: string;
  healthSystemId: string;
}

/** A legacy `ResourceType.path` target, parsed. */
export interface LegacyFieldTarget {
  /** The resource type, or `*` for every type. */
  resourceType: string;
  path: readonly string[];
  target: string;
}

/**
 * Parse one legacy `field` target, `ResourceType.path.to.field`.
 *
 * Returns null for anything that does not name a field below a resource type:
 * a bare `Patient` (a `resource` rule, not a `field` one), an empty target, or
 * a path that is nothing but array markers.
 */
export function parseFieldTarget(target: string): LegacyFieldTarget | null {
  const trimmed = target.trim();
  const dot = trimmed.indexOf(".");
  if (dot <= 0) return null;
  const resourceType = trimmed.slice(0, dot).trim();
  const parsed = parsePath(trimmed.slice(dot + 1));
  return resourceType.length === 0 || !parsed.ok
    ? null
    : { resourceType, path: parsed.segments, target: trimmed };
}

/** {@link PolicyRules} while it is still being filled in. */
interface Buckets {
  tools: Set<string>;
  resources: Set<string>;
  healthSystems: Set<string>;
  fields: FieldRule[];
  allows: FieldRule[];
  unparsed: string[];
}

function emptyBuckets(): Buckets {
  return {
    tools: new Set(),
    resources: new Set(),
    healthSystems: new Set(),
    fields: [],
    allows: [],
    unparsed: [],
  };
}

/** A blank or null column as null, otherwise trimmed. */
function scopeValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" || trimmed === "*" ? null : trimmed;
}

/** The stored path list, or null when the column is absent or not a string array. */
function storedPaths(json: string | null | undefined): string[] | null {
  if (json === null || json === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : [];
}

/**
 * An `allow` rule can only name a top-level field: `sensitive` lists top-level
 * keys of the normalized item, so a deeper path has nothing to put back.
 */
function allowable(path: readonly string[]): boolean {
  return path.length === 1 && path[0] !== ARRAY_SEGMENT;
}

/** Sort one 0012-shaped `field` row into the hide or allow list. */
function addStructuredField(buckets: Buckets, row: PolicyRuleInput, paths: string[]): void {
  const effect: FieldEffect = row.effect === "allow" ? "allow" : "hide";
  const scope = {
    tool: scopeValue(row.scope_tool),
    resourceType: scopeValue(row.scope_resource),
    healthSystemId: scopeValue(row.scope_health_system),
  };
  if (paths.length === 0) {
    buckets.unparsed.push(row.target);
    return;
  }
  for (const text of paths) {
    const parsed = parsePath(text);
    if (!parsed.ok || (effect === "allow" && !allowable(parsed.segments))) {
      buckets.unparsed.push(row.target);
      return;
    }
  }
  for (const text of paths) {
    const parsed = parsePath(text);
    if (!parsed.ok) continue;
    const rule: FieldRule = {
      ...scope,
      path: parsed.segments,
      display: formatPath(parsed.segments),
    };
    if (effect === "allow") buckets.allows.push(rule);
    else buckets.fields.push(rule);
  }
}

/** Sort one pre-0012 `field` row, a single `[allow:]ResourceType.path` string. */
function addLegacyField(buckets: Buckets, target: string): void {
  const allow = target.startsWith(ALLOW_PREFIX);
  const parsed = parseFieldTarget(allow ? target.slice(ALLOW_PREFIX.length) : target);
  if (parsed === null || (allow && !allowable(parsed.path))) {
    buckets.unparsed.push(target);
    return;
  }
  const rule: FieldRule = {
    tool: null,
    resourceType: scopeValue(parsed.resourceType),
    healthSystemId: null,
    path: parsed.path,
    display: formatPath(parsed.path),
  };
  if (allow) buckets.allows.push(rule);
  else buckets.fields.push(rule);
}

/**
 * Sort one row into its bucket.
 *
 * A function rather than inline in `buildRules`'s loop: each case returns, and
 * the switch keeps the exhaustiveness check over `PolicyRuleType` -- so adding
 * a fifth rule kind is a compile error rather than a silent no-op.
 */
function addRule(buckets: Buckets, row: PolicyRuleInput, target: string): void {
  switch (row.rule_type) {
    case "tool": {
      buckets.tools.add(target);
      return;
    }
    case "resource": {
      buckets.resources.add(target);
      return;
    }
    case "health_system": {
      buckets.healthSystems.add(target);
      return;
    }
    case "field": {
      const paths = storedPaths(row.paths_json);
      if (paths === null) addLegacyField(buckets, target);
      else addStructuredField(buckets, row, paths);
      return;
    }
  }
}

/** Build the parsed rule set from raw `mcp_policy` rows, skipping disabled ones. */
export function buildRules(rows: readonly PolicyRuleInput[]): PolicyRules {
  const buckets = emptyBuckets();
  for (const row of rows) {
    if (row.enabled === 0) continue;
    const target = row.target.trim();
    const structured = row.rule_type === "field" && storedPaths(row.paths_json) !== null;
    if (!structured && target === "") buckets.unparsed.push(row.target);
    else addRule(buckets, row, target);
  }
  return buckets;
}

/**
 * The structured form of one `field` row, for the admin UI: the 0012 columns,
 * or a legacy target read as a resource-type-scoped rule with one path. Null
 * for the other rule kinds, and for a legacy target that does not parse.
 */
export function fieldSpecOf(row: PolicyRuleInput): FieldRuleSpec | null {
  if (row.rule_type !== "field") return null;
  const paths = storedPaths(row.paths_json);
  if (paths !== null) {
    return {
      effect: row.effect === "allow" ? "allow" : "hide",
      tool: scopeValue(row.scope_tool),
      resourceType: scopeValue(row.scope_resource),
      healthSystemId: scopeValue(row.scope_health_system),
      paths,
    };
  }
  const target = row.target.trim();
  const allow = target.startsWith(ALLOW_PREFIX);
  const parsed = parseFieldTarget(allow ? target.slice(ALLOW_PREFIX.length) : target);
  return parsed === null
    ? null
    : {
        effect: allow ? "allow" : "hide",
        tool: null,
        resourceType: scopeValue(parsed.resourceType),
        healthSystemId: null,
        paths: [formatPath(parsed.path)],
      };
}

/** True when this tool is denied outright and must not read anything. */
export function isToolDenied(rules: PolicyRules, tool: string): boolean {
  return rules.tools.has(tool);
}

/** True when this health system must not be read from, listed or mentioned. */
export function isHealthSystemDenied(rules: PolicyRules, healthSystemId: string): boolean {
  return rules.healthSystems.has(healthSystemId);
}

/** True when a scoped field rule reaches an item in this scope. */
export function ruleReaches(rule: FieldRule, scope: ItemScope): boolean {
  return (
    (rule.tool === null || rule.tool === scope.tool) &&
    (rule.resourceType === null || rule.resourceType === scope.resourceType) &&
    (rule.healthSystemId === null || rule.healthSystemId === scope.healthSystemId)
  );
}

/** True when a `sensitive` field has been explicitly put back for items in this scope. */
export function isSensitiveAllowed(rules: PolicyRules, scope: ItemScope, field: string): boolean {
  return rules.allows.some((rule) => rule.path[0] === field && ruleReaches(rule, scope));
}

/** The hide rules that reach one item. */
export function fieldRulesFor(rules: PolicyRules, scope: ItemScope): FieldRule[] {
  return rules.fields.filter((rule) => ruleReaches(rule, scope));
}
