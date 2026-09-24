/**
 * Write-time checks for a `field` rule, and the one canonical form it is
 * stored in.
 *
 * A rule already stored is applied as-is regardless of anything here, so
 * tightening these checks never breaks a rule that got in before them. What
 * this refuses is a rule that cannot remove anything: a path that names no
 * field in any shape the rule's scope can reach, in either vocabulary, a tool
 * that does not exist, a tool/resource-type pair that never meet. Each refusal
 * says why in a sentence the admin UI shows verbatim, with a suggestion when a
 * near miss is obvious.
 *
 * The check walks `worker/policy/tree.ts`: the path as written against every
 * shape in scope, plus its alias translations (`aliases.ts`) against the shapes
 * of the other vocabulary -- so `Observation.value` (normalized) and
 * `Observation.component[].valueQuantity.value` (raw) are both accepted, each
 * because it names something real.
 */

import { ARRAY_SEGMENT, formatPath, parsePath } from "@shared/policy-path.ts";

import { TOOL_NAMES } from "../mcp/tool-names.ts";

import { expandPath } from "./aliases.ts";
import {
  MODELED_RESOURCE_TYPES,
  SENSITIVE_FIELDS,
  resolveInShape,
  shapeResourceType,
  shapeVocabulary,
  shapesForScope,
} from "./tree.ts";

import type { Resolution } from "./tree.ts";
import type { FieldRuleSpec } from "@shared/types.ts";

export type FieldSpecCheck = { ok: true; spec: FieldRuleSpec } | { ok: false; issues: string[] };

/** Edit distance, for "did you mean". Small inputs only: field names. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charAt(i - 1).toLowerCase() === b.charAt(j - 1).toLowerCase() ? 0 : 1;
      const deletion = (previous.at(j) ?? 0) + 1;
      const insertion = (current.at(j - 1) ?? 0) + 1;
      const substitution = (previous.at(j - 1) ?? 0) + cost;
      current.push(Math.min(deletion, insertion, substitution));
    }
    previous = current;
  }
  return previous.at(b.length) ?? 0;
}

/** The option nearest `failed`, when one is near enough to be a typo of it. */
function suggestion(failed: string, options: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Math.max(2, Math.floor(failed.length / 3)) + 1;
  for (const option of options) {
    const d = distance(failed, option);
    if (d >= bestDistance) continue;
    best = option;
    bestDistance = d;
  }
  return best;
}

type Failure = Extract<Resolution, { ok: false }>;

/** The deeper of two failures: it says more about where the path went wrong. */
function deeper(a: Failure | null, b: Failure): Failure {
  return a !== null && a.matched.length >= b.matched.length ? a : b;
}

/**
 * Try one parsed path against one shape: as written, then as translated into
 * the shape's vocabulary. The canonical form when it resolves as written; the
 * path itself when only a translation resolves; else the failure.
 */
function resolveOne(
  path: readonly string[],
  shape: string,
): { canonical: readonly string[] } | { failure: Failure } {
  const asWritten = resolveInShape(shape, path);
  if (asWritten.ok) return { canonical: asWritten.canonical };
  const resourceType = shapeResourceType(shape) ?? "";
  const direction = shapeVocabulary(shape) === "raw" ? "toRaw" : "toNormalized";
  const translated = expandPath(resourceType, path, direction).slice(1);
  return translated.some((candidate) => resolveInShape(shape, candidate).ok)
    ? { canonical: path }
    : { failure: asWritten };
}

/** Try one parsed path against every shape in scope, in both vocabularies. */
function resolvePath(
  path: readonly string[],
  shapes: readonly string[],
): { canonical: readonly string[] } | { failure: Failure | null } {
  let deepest: Failure | null = null;
  let translated: readonly string[] | null = null;
  for (const shape of shapes) {
    const result = resolveOne(path, shape);
    if ("failure" in result) deepest = deeper(deepest, result.failure);
    // A path that resolves as written wins outright: its canonical form, with
    // the `[]`s the tree knows about, is what gets stored.
    else if (result.canonical === path) {
      translated = path;
    } else {
      return result;
    }
  }
  return translated === null ? { failure: deepest } : { canonical: translated };
}

function scopeName(spec: FieldRuleSpec): string {
  if (spec.tool !== null && spec.resourceType !== null) {
    return `${spec.resourceType} items in ${spec.tool}'s answers`;
  }
  if (spec.tool !== null) return `${spec.tool}'s answers`;
  return spec.resourceType === null
    ? "any tool's answers"
    : `${spec.resourceType} items or raw resources`;
}

/** The sentence for a path that matched nothing. */
function unmatched(text: string, spec: FieldRuleSpec, failure: Failure | null): string {
  const head = `"${text}" matches nothing in ${scopeName(spec)}`;
  if (failure === null) return `${head}.`;
  if (failure.failed === ARRAY_SEGMENT) {
    return `${head}: ${formatPath(failure.matched)} is not an array, so [] cannot follow it.`;
  }
  const near = suggestion(failure.failed, failure.options);
  const hint = near === undefined ? "" : ` Did you mean "${near}"?`;
  const where =
    failure.matched.length === 0 ? "at the top level" : `under ${formatPath(failure.matched)}`;
  const known =
    failure.options.length > 0 && failure.options.length <= 12
      ? ` (there: ${failure.options.join(", ")})`
      : "";
  return `${head}: there is no "${failure.failed}" ${where}${known}.${hint}`;
}

function checkScope(spec: FieldRuleSpec, healthSystemIds: ReadonlySet<string>): string[] {
  const issues: string[] = [];
  if (spec.tool !== null && !(TOOL_NAMES as readonly string[]).includes(spec.tool)) {
    issues.push(`there is no tool called "${spec.tool}"`);
  }
  if (spec.healthSystemId !== null && !healthSystemIds.has(spec.healthSystemId)) {
    issues.push("that health system does not exist");
  }
  const typed = spec.tool !== null && spec.resourceType !== null;
  if (
    typed &&
    issues.length === 0 &&
    MODELED_RESOURCE_TYPES.includes(spec.resourceType ?? "") &&
    shapesForScope(spec).length === 0
  ) {
    issues.push(`${spec.tool ?? ""} never returns ${spec.resourceType ?? ""} items`);
  }
  if (spec.paths.length === 0) issues.push("pick at least one field");
  return issues;
}

/** Every field withheld by default, as "Type field" phrases. */
function sensitiveList(): string {
  const phrases: string[] = [];
  for (const [type, fields] of SENSITIVE_FIELDS) {
    for (const name of fields) phrases.push(`${type} ${name}`);
  }
  return phrases.join(", ");
}

/** `allow` puts back a field withheld by default; nothing else can be allowed. */
function checkAllow(spec: FieldRuleSpec, paths: readonly (readonly string[])[]): string[] {
  const types = spec.resourceType === null ? SENSITIVE_FIELDS.keys() : [spec.resourceType];
  const allowable = new Set<string>();
  for (const type of types) {
    const fields = SENSITIVE_FIELDS.get(type) ?? [];
    for (const field of fields) allowable.add(field);
  }
  const issues: string[] = [];
  for (const path of paths) {
    const field = path.length === 1 ? (path[0] ?? "") : "";
    if (allowable.has(field)) continue;
    issues.push(
      `"${formatPath(path)}" is not withheld by default, so there is nothing to allow (only ${sensitiveList()} are)`,
    );
  }
  return issues;
}

/** A trimmed scope value, or null for blank. */
function scopeOf(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** Parse every path, or report each one that does not parse. */
function parseAll(texts: readonly string[]): { parsed: string[][]; issues: string[] } {
  const parsed: string[][] = [];
  const issues: string[] = [];
  for (const text of texts) {
    const result = parsePath(text);
    if (result.ok) parsed.push(result.segments);
    else issues.push(`"${text}": ${result.message}`);
  }
  return { parsed, issues };
}

/** Resolve every path in scope; the canonical spellings, or why each one failed. */
function resolveAll(
  spec: FieldRuleSpec,
  parsed: readonly (readonly string[])[],
): { canonical: Set<string>; issues: string[] } {
  const canonical = new Set<string>();
  const issues: string[] = [];
  // A resource type this server has no model for cannot be proven wrong, and an
  // `allow` rule was checked against the sensitive list: taken as written.
  const asWritten =
    spec.effect === "allow" ||
    (spec.resourceType !== null && !MODELED_RESOURCE_TYPES.includes(spec.resourceType));
  const shapes = shapesForScope(spec);
  for (const [index, path] of parsed.entries()) {
    const result = asWritten ? { canonical: path } : resolvePath(path, shapes);
    if ("canonical" in result) canonical.add(formatPath(result.canonical));
    else issues.push(unmatched(spec.paths.at(index) ?? "", spec, result.failure));
  }
  return { canonical, issues };
}

/**
 * Check a `field` rule and return it canonicalized: trimmed scope, each path
 * in its canonical spelling (with `[]` written in where it steps into an
 * array), duplicates dropped, sorted.
 */
export function checkFieldSpec(
  input: FieldRuleSpec,
  healthSystemIds: ReadonlySet<string>,
): FieldSpecCheck {
  const spec: FieldRuleSpec = {
    effect: input.effect,
    tool: scopeOf(input.tool),
    resourceType: scopeOf(input.resourceType),
    healthSystemId: scopeOf(input.healthSystemId),
    paths: input.paths,
  };
  const scopeIssues = checkScope(spec, healthSystemIds);
  if (scopeIssues.length > 0) return { ok: false, issues: scopeIssues };

  const { parsed, issues: parseIssues } = parseAll(spec.paths);
  if (parseIssues.length > 0) return { ok: false, issues: parseIssues };
  const allowIssues = spec.effect === "allow" ? checkAllow(spec, parsed) : [];
  if (allowIssues.length > 0) return { ok: false, issues: allowIssues };

  const { canonical, issues } = resolveAll(spec, parsed);
  if (issues.length > 0) return { ok: false, issues };
  // eslint-disable-next-line unicorn/no-array-sort -- Array#toSorted is ES2023 and the Worker compiles against the ES2022 lib; the array is fresh from the spread.
  const paths = [...canonical].sort((a, b) => a.localeCompare(b));
  return { ok: true, spec: { ...spec, paths } };
}

/** The `target` a `field` row is stored under: one string per distinct rule. */
export function fieldSignature(spec: FieldRuleSpec): string {
  return JSON.stringify([
    spec.effect,
    spec.tool ?? "*",
    spec.resourceType ?? "*",
    spec.healthSystemId ?? "*",
    spec.paths,
  ]);
}
