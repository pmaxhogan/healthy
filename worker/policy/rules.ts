/**
 * The exposure deny-list, parsed.
 *
 * `mcp_policy` rows are free text on the way in (the admin UI writes whatever the
 * owner typed). This module is where they stop being text: every row is parsed
 * once per MCP request into the shape {@link applyPolicy} can enforce without
 * re-parsing, and a row that parses to nothing is reported rather than silently
 * ignored.
 *
 * The model is allow-all with a deny-list, in four kinds:
 *
 *   `tool`      the tool name. A denied tool answers `policy_denied` and reads
 *               nothing at all.
 *   `resource`  a FHIR resource type. Items of that type are dropped from every
 *               tool's output, the raw projection and the cross-health system summary.
 *   `health_system`  a health system id. The health system disappears everywhere, `list_health_systems`
 *               included, and is never even queried.
 *   `field`     a path, `ResourceType.path.to.field` or `*.field`. Deep-deleted
 *               from the normalized item and from the raw resource. A segment of
 *               `[]` (either on its own or suffixed to the segment before it)
 *               means "into every element of this array".
 *
 * The one rule that adds rather than removes is a `field` target prefixed
 * `allow:`. Fields an item names in its own `sensitive` array are withheld by
 * DEFAULT -- birth date, subscriber id -- so `allow:Patient.birthDate` is how the
 * owner puts one back. Nothing else can widen exposure.
 */

import { NORMALIZED_TYPES } from "../fhir/normalize/index.ts";

import { fieldResolves } from "./aliases.ts";

import type { PolicyRuleType } from "../db/rows.ts";

/** Marks a field target that re-enables a `sensitive` field rather than denying one. */
export const ALLOW_PREFIX = "allow:";

/** The path segment standing for "every element of this array". */
export const ARRAY_SEGMENT = "[]";

/** One parsed `field` deny rule. */
export interface FieldRule {
  /** The resource type it applies to, or `*` for every type. */
  resourceType: string;
  /** Path below the item root. `[]` steps into every element of an array. */
  path: readonly string[];
  /** The target exactly as stored, for the warning that says what was removed. */
  target: string;
}

/** Everything the filter needs, parsed once per request. */
export interface PolicyRules {
  /** Tool names that answer `policy_denied`. */
  tools: ReadonlySet<string>;
  /** FHIR resource types that never appear in any output. */
  resources: ReadonlySet<string>;
  /** Health system ids that are never read from and never listed. */
  healthSystems: ReadonlySet<string>;
  /** Field paths deep-deleted from normalized items and raw resources. */
  fields: readonly FieldRule[];
  /**
   * `ResourceType.field` (or `*.field`) pairs the owner has explicitly put back
   * after the `sensitive` default withheld them.
   */
  allowedSensitive: ReadonlySet<string>;
  /** Targets that parsed to nothing, so the admin UI can be told. */
  unparsed: readonly string[];
}

/** No rules at all: everything is exposed. The posture on a fresh database. */
export const EMPTY_RULES: PolicyRules = {
  tools: new Set(),
  resources: new Set(),
  healthSystems: new Set(),
  fields: [],
  allowedSensitive: new Set(),
  unparsed: [],
};

/** The shape of an `mcp_policy` row this module reads. */
export interface PolicyRuleInput {
  rule_type: PolicyRuleType;
  target: string;
}

/**
 * Split a dotted target into path segments, expanding array markers.
 *
 * `components[].value` and `components.[].value` are the same path: both mean
 * "the `value` of every element of `components`". Accepting both spellings is
 * deliberate -- the owner types these by hand.
 */
function splitPath(rest: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of rest) {
    let segment = raw;
    // A segment may carry more than one suffix (`a[][]`), so strip in a loop.
    let arrays = 0;
    while (segment.endsWith(ARRAY_SEGMENT)) {
      segment = segment.slice(0, -ARRAY_SEGMENT.length);
      arrays += 1;
    }
    if (segment.length > 0) out.push(segment);
    for (let index = 0; index < arrays; index++) out.push(ARRAY_SEGMENT);
  }
  return out;
}

/**
 * Parse one `field` target.
 *
 * Returns null for anything that does not name a field below a resource type:
 * a bare `Patient` (which is a `resource` rule, not a `field` one), an empty
 * target, or a path that is nothing but array markers.
 */
export function parseFieldTarget(target: string): FieldRule | null {
  const trimmed = target.trim();
  if (trimmed.length === 0) return null;
  const segments = trimmed.split(".");
  const resourceType = segments[0]?.trim() ?? "";
  if (resourceType.length === 0 || segments.length < 2) return null;
  const path = splitPath(segments.slice(1).map((segment) => segment.trim()));
  // A path of array markers alone would delete the item's own fields wholesale.
  return path.every((segment) => segment === ARRAY_SEGMENT)
    ? null
    : { resourceType, path, target: trimmed };
}

/**
 * Parse an `allow:` target into the `ResourceType.field` key the sensitive
 * default is keyed by.
 *
 * Only a single-segment field can be re-enabled: `sensitive` names top-level
 * fields of the normalized item, so a deeper path has nothing to match.
 */
function parseAllowTarget(target: string): string | null {
  const body = target.slice(ALLOW_PREFIX.length).trim();
  const segments = body.split(".").map((segment) => segment.trim());
  if (segments.length !== 2) return null;
  const [resourceType, field] = segments;
  return !resourceType || !field ? null : `${resourceType}.${field}`;
}

/** {@link PolicyRules} while it is still being filled in. */
interface Buckets {
  tools: Set<string>;
  resources: Set<string>;
  healthSystems: Set<string>;
  fields: FieldRule[];
  allowedSensitive: Set<string>;
  unparsed: string[];
}

/** Sort one `field` row into the deny list or the sensitive allow list. */
function addFieldRule(buckets: Buckets, target: string): void {
  if (target.startsWith(ALLOW_PREFIX)) {
    const allow = parseAllowTarget(target);
    if (allow === null) buckets.unparsed.push(target);
    else buckets.allowedSensitive.add(allow);
    return;
  }
  const rule = parseFieldTarget(target);
  if (rule === null) buckets.unparsed.push(target);
  else buckets.fields.push(rule);
}

/**
 * Sort one row into its bucket.
 *
 * A function rather than inline in `buildRules`'s loop: a `switch` inside a loop
 * needs a `break` per case, which reads as if it left the loop. Here each case
 * returns, and the switch keeps the exhaustiveness check over `PolicyRuleType` --
 * so adding a fifth rule kind is a compile error rather than a silent no-op.
 */
function addRule(buckets: Buckets, ruleType: PolicyRuleType, target: string): void {
  switch (ruleType) {
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
      addFieldRule(buckets, target);
      return;
    }
  }
}

/** Build the parsed rule set from raw `mcp_policy` rows. */
export function buildRules(rows: readonly PolicyRuleInput[]): PolicyRules {
  const buckets: Buckets = {
    tools: new Set(),
    resources: new Set(),
    healthSystems: new Set(),
    fields: [],
    allowedSensitive: new Set(),
    unparsed: [],
  };

  for (const row of rows) {
    const target = row.target.trim();
    if (target.length === 0) buckets.unparsed.push(row.target);
    else addRule(buckets, row.rule_type, target);
  }

  return buckets;
}

/** True when this tool is denied outright and must not read anything. */
export function isToolDenied(rules: PolicyRules, tool: string): boolean {
  return rules.tools.has(tool);
}

/** True when this health system must not be read from, listed or mentioned. */
export function isHealthSystemDenied(rules: PolicyRules, healthSystemId: string): boolean {
  return rules.healthSystems.has(healthSystemId);
}

/** True when a `sensitive` field has been explicitly put back by the owner. */
export function isSensitiveAllowed(
  rules: PolicyRules,
  resourceType: string,
  field: string,
): boolean {
  return (
    rules.allowedSensitive.has(`${resourceType}.${field}`) ||
    rules.allowedSensitive.has(`*.${field}`)
  );
}

/** The field rules that apply to one resource type, wildcards included. */
export function fieldRulesFor(rules: PolicyRules, resourceType: string): FieldRule[] {
  return rules.fields.filter(
    (rule) => rule.resourceType === "*" || rule.resourceType === resourceType,
  );
}

/**
 * True when a structurally-parsed `field` rule names something real, in
 * either vocabulary, for at least one resource type it could apply to --
 * every type when `resourceType` is `*`. Used only at write time
 * (`POST /api/mcp/policy`): a rule already stored is applied as-is regardless
 * of what this says, so tightening the vocabulary here never breaks a rule
 * that got in before it existed.
 *
 * See `worker/policy/aliases.ts` for what "resolves" means -- the path or one
 * of its alias translations names a real normalized or raw field, checked
 * against the vocabulary the normalize layer and the `fhir` package actually
 * expose, not a rule that merely looks plausible.
 */
export function fieldRuleResolves(rule: FieldRule): boolean {
  return rule.resourceType === "*"
    ? NORMALIZED_TYPES.some((resourceType) => fieldResolves(resourceType, rule.path))
    : fieldResolves(rule.resourceType, rule.path);
}
