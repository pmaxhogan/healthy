/**
Where the exposure policy meets Health Connect's derived data.

`applyPolicy` judges a row by the `resourceType` it is tagged with. Two
kinds of phone data carry numbers that belong to a DIFFERENT record type
than the row's own, and a deny rule has to follow them there or it can be
walked around:

 - The platform aggregates. The phone uploads Health Connect's own hourly
   totals as `Agg.<Metric>` records; `Agg.Steps` is step data. An aggregate
   type is therefore not a policy object of its own: it inherits the
   decision made for the type it aggregates ({@link sourceTypeOf}), and is
   denied when either is.
 - Joined fields. A night's row carries the overnight heart rate, a day's
   row the night's skin temperature, a blood-pressure reading the pulse.
   `JOINED_FIELDS` (`worker/src/policy/hc-fields.ts`) is the one table of
   which field of which tool's rows was measured as which record type(s).

What this module does with them is the `resource` half: {@link stripJoined}
removes a joined field when any of its types is denied, and every tool that
joins passes its rows through it on the way out. The `field` half -- a rule
that hides one field of a type, wherever that field ends up -- is done by
the policy filter itself, from the same table
(`worker/src/policy/hc-aliases.ts`).

Both run before or inside `respond()`: the policy filter there is still what
removes a denied row, a denied phone and a hidden field.
*/

import { coverageResourceType } from "../../hc/coverage.ts";
import { hcFieldRuleNames } from "../../policy/hc-aliases.ts";
import { JOINED_FIELDS, PLATFORM_PAIRS } from "../../policy/hc-fields.ts";

import type { JoiningTool } from "../../policy/hc-fields.ts";
import type { PolicyRules } from "../../policy/rules.ts";

export { JOINED_FIELDS, OWN_FIELDS } from "../../policy/hc-fields.ts";
export type { JoiningTool } from "../../policy/hc-fields.ts";

const AGG_PREFIX = "Agg.";

const PLATFORM_METRICS: ReadonlyMap<string, string> = new Map(PLATFORM_PAIRS);

const SOURCE_OF_METRIC: ReadonlyMap<string, string> = new Map(
  PLATFORM_PAIRS.map(([type, metric]) => [metric, type]),
);

/** Every record type the platform aggregates. */
export const PLATFORM_AGGREGATED_TYPES: readonly string[] = PLATFORM_PAIRS.map(([type]) => type);

export function isPlatformAggregate(type: string): boolean {
  return type.startsWith(AGG_PREFIX);
}

/** The `Agg.<Metric>` type that carries the platform's own aggregate of `type`, if any. */
export function platformAggregateType(type: string): string | null {
  const metric = PLATFORM_METRICS.get(type);
  return metric === undefined ? null : `${AGG_PREFIX}${metric}`;
}

/**
The record type an `Agg.<Metric>` type is data of; null for an aggregate
this Worker has no mapping for, and for any ordinary type.
*/
export function sourceTypeOf(type: string): string | null {
  return isPlatformAggregate(type)
    ? (SOURCE_OF_METRIC.get(type.slice(AGG_PREFIX.length)) ?? null)
    : null;
}

/**
True for an `Agg.<Metric>` this Worker has no source type for: a metric a
newer companion app uploads. It cannot be read -- nothing says whose data it
is, so no rule could cover it -- but that is "unknown", not "denied".
*/
function isUnknownAggregate(type: string): boolean {
  return isPlatformAggregate(type) && sourceTypeOf(type) === null;
}

/**
True unless a `resource` rule denies `hc:<type>` -- or, for a platform
aggregate, the type it aggregates. An aggregate with no known source cannot
be shown to be allowed, so it is not.
*/
export function typeAllowed(rules: PolicyRules, type: string): boolean {
  if (rules.resources.has(coverageResourceType(type))) return false;
  if (!isPlatformAggregate(type)) return true;
  const source = sourceTypeOf(type);
  return source !== null && !rules.resources.has(coverageResourceType(source));
}

/**
The `resourceType` a row of `type` is tagged with. A platform aggregate's
rows are tagged as the type they are data of, so the policy filter itself
-- a `resource` rule, a `field` rule scoped to the type -- treats
`Agg.Steps` rows as the step data they are.
*/
export function policyResourceType(type: string): string {
  return coverageResourceType(sourceTypeOf(type) ?? type);
}

/**
The warning a tool adds for a type it did not read: `unknown_type:hc:<Type>`
for an aggregate nothing maps to a source type, and otherwise
`policy_resource_denied:hc:<Type>`, naming the type the rule is on.
*/
export function typeDeniedWarning(type: string): string {
  return isUnknownAggregate(type)
    ? `unknown_type:${coverageResourceType(type)}`
    : `policy_resource_denied:${policyResourceType(type)}`;
}

/**
True when a `field` rule in force for `tool` hides `field` of `type`, under
any of its spellings. For the one case a tool must know BEFORE it computes:
a number derived from the field that is folded into another number (the
basal-metabolic padding added to a calorie total), which no path can pick
back out afterwards.
*/
export function fieldHidden(
  rules: PolicyRules,
  tool: string,
  type: string,
  field: string,
): boolean {
  return rules.fields.some(
    (rule) => (rule.tool === null || rule.tool === tool) && hcFieldRuleNames(rule, type, field),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function without(row: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([name]) => name !== key));
}

/** `row` without `path` (one or two segments; an array in between is stepped into). */
function dropPath(row: Record<string, unknown>, path: string): Record<string, unknown> {
  const dot = path.indexOf(".");
  if (dot === -1) return without(row, path);
  const head = path.slice(0, dot);
  if (!Object.hasOwn(row, head)) return row;
  const rest = path.slice(dot + 1);
  const stripChild = (child: unknown): unknown => (isObject(child) ? without(child, rest) : child);
  return Object.fromEntries(
    Object.entries(row).map(([name, value]) => {
      if (name !== head) return [name, value];
      return [
        name,
        Array.isArray(value)
          ? (value as unknown[]).map((entry) => stripChild(entry))
          : stripChild(value),
      ];
    }),
  );
}

/** The joined fields of `tool` the policy withholds, with the warning for each denied type. */
export function deniedJoins(
  rules: PolicyRules,
  tool: JoiningTool,
): { fields: string[]; warnings: string[] } {
  const fields: string[] = [];
  const warnings = new Set<string>();
  const table: Record<string, readonly string[]> = JOINED_FIELDS[tool];
  for (const [field, types] of Object.entries(table)) {
    const denied = types.filter((type) => !typeAllowed(rules, type));
    if (denied.length === 0) continue;
    fields.push(field);
    for (const type of denied) warnings.add(typeDeniedWarning(type));
  }
  return { fields, warnings: [...warnings] };
}

/**
One row of `tool` with every joined field removed whose source type the
policy denies. The key is removed, never nulled: a null would say the type
exists and had nothing to report.
*/
export function stripJoined(
  rules: PolicyRules,
  tool: JoiningTool,
  row: Record<string, unknown>,
): Record<string, unknown> {
  let out = row;
  for (const field of deniedJoins(rules, tool).fields) out = dropPath(out, field);
  return out;
}
