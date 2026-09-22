/**
 * The choke point.
 *
 * Every MCP tool builds its answer, hands it to {@link applyPolicy}, and
 * serialises whatever comes back. Nothing else may serialise, and no tool
 * inspects the rules itself -- that is the whole design. One function, called in
 * one place (`worker/mcp/respond.ts`), is the only thing standing between the
 * FHIR cache and a third-party LLM, so it has to be small enough to read in one
 * sitting and impossible to route around.
 *
 * Two properties it is built to have, and that the tests assert on the final
 * serialised STRING rather than on the returned object:
 *
 *  1. Removal is total. A denied field is deep-deleted from the normalized item
 *     AND from the raw resource behind it, including inside arrays. A denied
 *     resource type or provider takes every item with it.
 *  2. Removal is immutable. Nothing here mutates its input: each item is rebuilt
 *     without the denied parts, so a cached object cannot be left damaged for
 *     the next caller and a half-applied filter cannot leave a field behind.
 *
 * Sensitive-by-default: an item that names fields in its own `sensitive` array
 * (see `worker/fhir/normalize/types.ts`) loses them unless the owner has added an
 * `allow:` rule. The `sensitive` key is then replaced by `withheld`, so the model
 * is told a field exists and was held back rather than being left to assume the
 * record is empty.
 */

import { expandPath } from "./aliases.ts";
import {
  ARRAY_SEGMENT,
  fieldRulesFor,
  isProviderDenied,
  isSensitiveAllowed,
  isToolDenied,
  type PolicyRules,
} from "./rules.ts";

import type { AliasDirection } from "./aliases.ts";

/** A raw FHIR resource as a tool hands it over, tagged with its provider. */
export interface RawEntry {
  /** Provider display name, matching the normalized item's `provider`. */
  provider: string;
  providerId: string;
  /** The resource exactly as it came out of the cache. */
  resource: unknown;
}

export interface ApplyPolicyInput {
  /** Tool name, for the `tool` rule kind. */
  tool: string;
  /** Normalized items, each a plain record carrying `resourceType`. */
  items: readonly unknown[];
  /** Optional raw projection, filtered by exactly the same rules. */
  rawItems?: readonly RawEntry[] | undefined;
  rules: PolicyRules;
}

export interface ApplyPolicyResult {
  /** True when the tool itself is denied: both lists are empty. */
  denied: boolean;
  items: unknown[];
  rawItems: RawEntry[];
  /**
   * Stable, non-identifying notes about what the policy removed: rule kinds,
   * resource type names and field paths only, never a value.
   */
  warnings: string[];
}

/**
 * The path walk's answer.
 *
 * `remove` means the caller one level up should drop this key, or this array
 * element, entirely -- it is how the end of a path is reported.
 *
 * `changed` exists because the rebuild is unconditional: `Object.fromEntries`
 * always produces a new object, so reference inequality says nothing about whether
 * anything was actually removed, and a warning keyed off it would fire for every
 * rule that matched no data.
 */
interface PruneResult {
  remove: boolean;
  changed: boolean;
  value: unknown;
}

const REMOVE: PruneResult = { remove: true, changed: true, value: undefined };

const unchanged = (value: unknown): PruneResult => ({ remove: false, changed: false, value });
const replaced = (value: unknown): PruneResult => ({ remove: false, changed: true, value });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rebuild `value` with the field at `path` gone.
 *
 * Returns {@link REMOVE} when `path` is exhausted, which is how the caller one
 * level up knows to drop the key (or the array element) entirely. A path that
 * does not exist in `value` leaves it untouched and reports `changed: false`, so
 * an over-broad rule is inert rather than destructive.
 */
function prune(value: unknown, path: readonly string[]): PruneResult {
  if (path.length === 0) return REMOVE;
  const head = path[0] ?? "";
  const rest = path.slice(1);
  if (head === ARRAY_SEGMENT) return pruneArray(value, rest);
  return isRecord(value) && Object.hasOwn(value, head)
    ? pruneRecord(value, head, rest)
    : unchanged(value);
}

/** Walk into every element of an array, dropping the ones that come back removed. */
function pruneArray(value: unknown, rest: readonly string[]): PruneResult {
  if (!Array.isArray(value)) return unchanged(value);
  let changed = false;
  const kept: unknown[] = [];
  for (const element of value as unknown[]) {
    const next = prune(element, rest);
    if (next.remove) {
      changed = true;
      continue;
    }
    if (next.changed) changed = true;
    kept.push(next.value);
  }
  return changed ? replaced(kept) : unchanged(value);
}

/**
 * Rebuild one record with `head` replaced or gone.
 *
 * Built from entries rather than by assigning `out[key]`: a computed write with a
 * variable key is exactly the prototype-pollution shape
 * `security/detect-object-injection` exists to flag, and `Object.fromEntries`
 * sidesteps it without a suppression.
 */
function pruneRecord(
  value: Record<string, unknown>,
  head: string,
  rest: readonly string[],
): PruneResult {
  let changed = false;
  const entries: [string, unknown][] = [];
  for (const [key, child] of Object.entries(value)) {
    if (key !== head) {
      entries.push([key, child]);
      continue;
    }
    const next = prune(child, rest);
    if (next.remove) {
      changed = true;
      continue;
    }
    if (next.changed) changed = true;
    entries.push([key, next.value]);
  }
  return changed ? replaced(Object.fromEntries(entries)) : unchanged(value);
}

/**
 * Apply every field rule that matches `resourceType` to one value.
 *
 * `shape` says which of the two projections `value` is: a rule's `path` is
 * whatever vocabulary the owner wrote it in, which is not necessarily this
 * one, so it is expanded through `worker/policy/aliases.ts` into every path
 * worth trying against `shape` before pruning -- the path exactly as written,
 * plus its translation when a known rename applies. That is what makes one
 * rule -- in either vocabulary -- strip the normalized item AND the raw
 * resource behind it, which `SECURITY.md` requires of the one exposure choke
 * point.
 */
function applyFieldRules(
  rules: PolicyRules,
  resourceType: string,
  shape: "normalized" | "raw",
  value: unknown,
  warnings: Set<string>,
): unknown {
  let current = value;
  const direction: AliasDirection = shape === "normalized" ? "toNormalized" : "toRaw";
  for (const rule of fieldRulesFor(rules, resourceType)) {
    let ruleChanged = false;
    for (const candidate of expandPath(resourceType, rule.path, direction)) {
      const next = prune(current, candidate);
      // `remove` is unreachable for a parsed (or alias-translated) rule: every
      // candidate keeps at least one segment, and only an empty path removes
      // at the top level.
      if (next.remove) continue;
      if (next.changed) ruleChanged = true;
      current = next.value;
    }
    if (ruleChanged) warnings.add(`policy_field_removed:${rule.target}`);
  }
  return current;
}

/**
 * Strip the fields `sensitiveByType` names from one raw resource.
 *
 * The raw FHIR carries no `sensitive` marker of its own, so without this
 * carry-over from the normalized items `raw: true` would be a way around the
 * default.
 */
function stripSensitiveRaw(
  resourceType: string,
  fields: ReadonlySet<string>,
  resource: unknown,
  warnings: Set<string>,
): unknown {
  let current = resource;
  for (const field of fields) {
    const next = prune(current, [field]);
    if (next.remove || !next.changed) continue;
    warnings.add(`sensitive_withheld:${resourceType}.${field}`);
    current = next.value;
  }
  return current;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * One own string property, or "".
 *
 * Read through `Reflect.get` after an own-property check rather than with
 * `value[key]`: the bracket form is the prototype-pollution shape
 * `security/detect-object-injection` flags, and an inherited `resourceType` is not
 * something this filter should ever act on.
 */
function stringField(value: unknown, key: string): string {
  if (!isRecord(value) || !Object.hasOwn(value, key)) return "";
  const found: unknown = Reflect.get(value, key);
  return typeof found === "string" ? found : "";
}

/**
 * Strip the fields an item declares sensitive, unless the owner allowed them.
 *
 * `sensitive` is replaced by `withheld` on the way out: the key never survives
 * into the serialised answer, because "here are the names of the fields you are
 * not being shown" is useful and "here is a list you might mistake for data" is
 * not.
 */
function stripSensitive(
  rules: PolicyRules,
  resourceType: string,
  item: Record<string, unknown>,
  warnings: Set<string>,
): Record<string, unknown> {
  const declared = stringArray(item.sensitive);
  if (declared.length === 0) return item;
  const withheld = declared.filter((field) => !isSensitiveAllowed(rules, resourceType, field));

  const entries: [string, unknown][] = [];
  for (const [key, value] of Object.entries(item)) {
    if (key === "sensitive" || withheld.includes(key)) continue;
    entries.push([key, value]);
  }
  if (withheld.length > 0) {
    entries.push(["withheld", withheld]);
    for (const field of withheld) warnings.add(`sensitive_withheld:${resourceType}.${field}`);
  }
  return Object.fromEntries(entries);
}

/** Field names the normalized items declared sensitive, by resource type. */
function collectSensitive(rules: PolicyRules, items: readonly unknown[]): Map<string, Set<string>> {
  const byType = new Map<string, Set<string>>();
  for (const item of items) {
    if (!isRecord(item)) continue;
    const resourceType = stringField(item, "resourceType");
    const declared = stringArray(item.sensitive).filter(
      (field) => !isSensitiveAllowed(rules, resourceType, field),
    );
    if (declared.length === 0) continue;
    const existing = byType.get(resourceType) ?? new Set<string>();
    for (const field of declared) existing.add(field);
    byType.set(resourceType, existing);
  }
  return byType;
}

/** Whole-item denials: the resource type, or the provider it came from. */
function itemDenied(
  rules: PolicyRules,
  resourceType: string,
  providerId: string,
  warnings: Set<string>,
): boolean {
  if (rules.resources.has(resourceType)) {
    warnings.add(`policy_resource_denied:${resourceType}`);
    return true;
  }
  if (providerId !== "" && isProviderDenied(rules, providerId)) {
    // No provider id in the warning: the deny-list is the owner's business, and a
    // tool's answer is read by a third-party model.
    warnings.add("policy_provider_denied");
    return true;
  }
  return false;
}

/**
 * Filter one tool's output.
 *
 * Order matters and is fixed: tool deny short-circuits everything; then provider
 * and resource-type denies drop whole items (no point filtering fields off
 * something that is leaving); then field rules; then the sensitive default. The
 * sensitive field names are collected from the normalized items BEFORE they are
 * stripped, and reused on the raw resources of the same type -- the raw FHIR
 * carries no `sensitive` marker of its own, so without that carry-over
 * `raw: true` would be a way around the default.
 */
export function applyPolicy(input: ApplyPolicyInput): ApplyPolicyResult {
  const { rules, tool } = input;
  if (isToolDenied(rules, tool)) {
    return { denied: true, items: [], rawItems: [], warnings: [`policy_tool_denied:${tool}`] };
  }

  const warnings = new Set<string>();
  const sensitiveByType = collectSensitive(rules, input.items);

  return {
    denied: false,
    items: filterItems(rules, input.items, warnings),
    rawItems: filterRaw(rules, input.rawItems ?? [], sensitiveByType, warnings),
    warnings: sortedWarnings(warnings),
  };
}

/** The normalized half: whole-item denials, then field rules, then `sensitive`. */
function filterItems(
  rules: PolicyRules,
  input: readonly unknown[],
  warnings: Set<string>,
): unknown[] {
  const items: unknown[] = [];
  for (const item of input) {
    // Anything that is not a record cannot be filtered: it carries no
    // `resourceType` to judge, no `providerId` to check and no `sensitive` list to
    // honour. No tool produces one today, and the choke point's contract is that
    // nothing leaves unfiltered -- so it is dropped rather than passed through.
    if (!isRecord(item)) {
      warnings.add("policy_unfilterable_item_dropped");
      continue;
    }
    const resourceType = stringField(item, "resourceType");
    if (itemDenied(rules, resourceType, stringField(item, "providerId"), warnings)) continue;
    const filtered = applyFieldRules(rules, resourceType, "normalized", item, warnings);
    items.push(
      isRecord(filtered) ? stripSensitive(rules, resourceType, filtered, warnings) : filtered,
    );
  }
  return items;
}

/** The raw half, held to the same rules plus the carried-over sensitive fields. */
function filterRaw(
  rules: PolicyRules,
  input: readonly RawEntry[],
  sensitiveByType: ReadonlyMap<string, ReadonlySet<string>>,
  warnings: Set<string>,
): RawEntry[] {
  const rawItems: RawEntry[] = [];
  for (const entry of input) {
    const resourceType = stringField(entry.resource, "resourceType");
    if (itemDenied(rules, resourceType, entry.providerId, warnings)) continue;
    const filtered = applyFieldRules(rules, resourceType, "raw", entry.resource, warnings);
    const resource = stripSensitiveRaw(
      resourceType,
      sensitiveByType.get(resourceType) ?? EMPTY_FIELDS,
      filtered,
      warnings,
    );
    rawItems.push({ provider: entry.provider, providerId: entry.providerId, resource });
  }
  return rawItems;
}

/** Shared empty set, so `filterRaw` allocates nothing per item in the common case. */
const EMPTY_FIELDS: ReadonlySet<string> = new Set<string>();

/**
 * Warnings as a sorted, de-duplicated list.
 *
 * Shared with `worker/mcp/respond.ts`, which merges a tool's own notes into the
 * policy's, so the two orderings cannot drift.
 */
export function sortedWarnings(values: Iterable<string>): string[] {
  // eslint-disable-next-line unicorn/no-array-sort -- Array#toSorted is ES2023 and the Worker compiles against the ES2022 lib; the array is created on the line above, so sorting in place mutates nothing shared.
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
