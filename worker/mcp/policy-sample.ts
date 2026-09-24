/**
 * The rule builder's two windows onto real data: the key structure of a tool's
 * answer, and a before/after preview of a draft `field` rule.
 *
 * Both run the REAL tool, through the same in-memory MCP server the admin
 * console's "Try a tool" panel uses (`admin-call.ts`) -- so the sample is
 * exactly what an assistant would be handed, summary sections, portal visits
 * and raw resources included, not a second rendering of it that could drift.
 * What differs is the rule set the tool runs under, supplied here instead of
 * read from `mcp_policy`, and three things a preview must not do:
 *
 *  - It writes no audit row. The audit log is what linked clients (and the
 *    owner, trying a tool) were answered; a preview, recomputed on every edit
 *    of a draft, is neither, and would bury the rows that matter.
 *  - It answers even while the MCP switch is off, so rules can be built before
 *    the surface is opened.
 *  - It never samples `get_document_text`, which is the one tool that can spend
 *    a health system's metered document quota. Its preview runs the draft over a
 *    made-up item of the tool's shape instead, and says so (`synthetic`).
 *
 * The baseline a draft is compared against is the owner's stored `resource` and
 * `health_system` rules -- what decides which items exist at all -- and none of
 * the `tool` or `field` rules: the diff shows the draft's own effect, on a tool
 * the owner may already have switched off.
 *
 * Nothing here logs a value. What leaves is the admin API's response, to the
 * owner's own browser, behind Access, the password session and the CSRF check.
 */

import { applyPolicy } from "../policy/filter.ts";
import { EMPTY_RULES, buildRules } from "../policy/rules.ts";
import { toolShapes } from "../policy/tree.ts";

import { callMcpTool } from "./admin-call.ts";

import type { ToolDeps } from "./deps.ts";
import type { McpPolicyRow } from "../db/rows.ts";
import type { RawEntry } from "../policy/filter.ts";
import type { PolicyRules } from "../policy/rules.ts";
import type {
  FieldRuleSpec,
  PolicyKeyNode,
  PolicyPreviewDto,
  PolicyStructureDto,
} from "@shared/types.ts";

/** The one tool never sampled for real. See the module comment. */
const METERED_TOOL = "get_document_text";

/** A tool answer, parsed: the items and, with `raw: true`, the raw entries. */
interface Answer {
  items: unknown[];
  raw: RawEntry[];
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
}

/** Deps that run under `rules`, write no audit row, and ignore the MCP switch. */
function sampleDeps(deps: ToolDeps, rules: PolicyRules): ToolDeps {
  return {
    ...deps,
    mcpEnabled: () => Promise.resolve(true),
    rules: () => Promise.resolve(rules),
    recordAudit: () => Promise.resolve(),
    pruneAudit: () => Promise.resolve(),
  };
}

/** The arguments that make a tool answer with everything it has. */
function sampleArgs(tool: string): Record<string, unknown> {
  const raw = (toolShapes(tool) ?? []).some((shape) => shape.startsWith("raw:"));
  return {
    ...(raw && { raw: true }),
    // Upcoming-only is the default window; the past has most of the data.
    ...(tool === "get_appointments" && { includePast: true }),
  };
}

function rawEntries(value: unknown): RawEntry[] {
  if (!Array.isArray(value)) return [];
  const out: RawEntry[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) continue;
    const healthSystem = own(entry, "healthSystem");
    const healthSystemId = own(entry, "healthSystemId");
    out.push({
      healthSystem: typeof healthSystem === "string" ? healthSystem : "",
      healthSystemId: typeof healthSystemId === "string" ? healthSystemId : "",
      resource: own(entry, "resource"),
    });
  }
  return out;
}

/** Run one tool under `rules`. Null when the tool does not exist or answered an error. */
async function runTool(deps: ToolDeps, tool: string, rules: PolicyRules): Promise<Answer | null> {
  const result = await callMcpTool(sampleDeps(deps, rules), tool, sampleArgs(tool));
  if (result === null || result.isError === true) return null;
  const first = result.content[0];
  if (first?.type !== "text") return null;
  const payload: unknown = JSON.parse(first.text);
  if (!isRecord(payload)) return null;
  const items = own(payload, "items");
  const warnings = own(payload, "warnings");
  return {
    items: Array.isArray(items) ? (items as unknown[]) : [],
    raw: rawEntries(own(payload, "raw")),
    warnings: Array.isArray(warnings)
      ? (warnings as unknown[]).filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

/** A made-up `get_document_text` item: the tool's shape, none of the owner's data. */
function syntheticDocumentText(): Answer {
  return {
    items: [
      {
        resourceType: "DocumentReference",
        kind: "document_text",
        healthSystem: "Example Health",
        healthSystemId: "example",
        id: "example-document",
        contentType: "text/plain",
        cached: true,
        chars: 44,
        text: "Example note text. Not from your record.",
      },
    ],
    raw: [],
    warnings: [],
  };
}

/** Keep only one resource type's items (and, index-aligned, their raw entries). */
function onlyType(answer: Answer, resourceType: string | undefined): Answer {
  if (resourceType === undefined) return answer;
  const items: unknown[] = [];
  const raw: RawEntry[] = [];
  for (const [index, item] of answer.items.entries()) {
    if (!isRecord(item) || own(item, "resourceType") !== resourceType) continue;
    items.push(item);
    const entry = answer.raw.at(index);
    if (entry !== undefined) raw.push(entry);
  }
  return { items, raw, warnings: answer.warnings };
}

/** The stored rules a preview's baseline keeps: which items exist, nothing else. */
function baselineRules(rows: readonly McpPolicyRow[]): PolicyRules {
  return buildRules(
    rows.filter((row) => row.rule_type === "resource" || row.rule_type === "health_system"),
  );
}

// --- structure ---------------------------------------------------------------

/** Mutable key tree while it is being merged. `Map`s, so no key is ever an object index. */
interface KeyTree {
  array: boolean;
  children: Map<string, KeyTree>;
}

function newTree(): KeyTree {
  return { array: false, children: new Map() };
}

/** Merge the keys of `value` into `tree`. Arrays merge every element's keys. */
function mergeKeys(tree: KeyTree, value: unknown): void {
  if (Array.isArray(value)) {
    tree.array = true;
    for (const element of value as unknown[]) mergeKeys(tree, element);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    let node = tree.children.get(key);
    if (node === undefined) {
      node = newTree();
      tree.children.set(key, node);
    }
    mergeKeys(node, child);
  }
}

function toKeyNodes(tree: KeyTree): PolicyKeyNode[] {
  const nodes: PolicyKeyNode[] = [];
  for (const [name, node] of tree.children) {
    const children = toKeyNodes(node);
    nodes.push({
      name,
      ...(node.array && { array: true }),
      ...(children.length > 0 && { children }),
    });
  }
  // eslint-disable-next-line unicorn/no-array-sort -- Array#toSorted is ES2023 and the Worker compiles against the ES2022 lib; `nodes` is built above.
  return nodes.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The key structure of one tool's real answer -- every key any item has, at
 * every depth, arrays marked. Names only: no value leaves this function.
 * Run with no rules at all, so a key the owner has already hidden still shows.
 */
export async function sampleStructure(
  deps: ToolDeps,
  tool: string,
  resourceType?: string,
): Promise<PolicyStructureDto | null> {
  if (tool === METERED_TOOL) return { tool, items: 0, item: [], raw: [] };
  const answer = await runTool(deps, tool, EMPTY_RULES);
  if (answer === null) return null;
  const sample = onlyType(answer, resourceType);
  const item = newTree();
  for (const entry of sample.items) mergeKeys(item, entry);
  const raw = newTree();
  for (const entry of sample.raw) mergeKeys(raw, entry.resource);
  return { tool, items: sample.items.length, item: toKeyNodes(item), raw: toKeyNodes(raw) };
}

// --- preview -----------------------------------------------------------------

/** The draft as one parsed rule set, added to the baseline. */
function withDraft(baseline: readonly McpPolicyRow[], draft: FieldRuleSpec): PolicyRules {
  return buildRules([
    ...baseline.filter((row) => row.rule_type === "resource" || row.rule_type === "health_system"),
    {
      rule_type: "field",
      target: "draft",
      effect: draft.effect,
      scope_tool: draft.tool,
      scope_resource: draft.resourceType,
      scope_health_system: draft.healthSystemId,
      paths_json: JSON.stringify(draft.paths),
    },
  ]);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Warnings in `after` that `before` did not have: what the draft adds. */
function addedWarnings(before: readonly string[], after: readonly string[]): string[] {
  const had = new Set(before);
  return after.filter((warning) => !had.has(warning));
}

/**
 * Run a draft rule over one tool's real answer and report what it changes.
 *
 * The tool runs twice -- under the baseline, and under the baseline plus the
 * draft -- rather than once with the draft applied to the result afterwards: an
 * `allow` rule puts back a field the baseline already stripped, which only a
 * run with the rule in place can show. The two answers line up item for item
 * (a field rule never drops an item), so the first item that differs is the
 * sample, and the count of those that differ is `affected`.
 */
export async function previewDraft(
  deps: ToolDeps,
  stored: readonly McpPolicyRow[],
  input: { tool: string; resourceType?: string | undefined; field: FieldRuleSpec },
): Promise<PolicyPreviewDto | null> {
  const before = baselineRules(stored);
  const after = withDraft(stored, input.field);
  const synthetic = input.tool === METERED_TOOL;

  let beforeAnswer: Answer | null;
  let afterAnswer: Answer | null;
  if (synthetic) {
    const sample = syntheticDocumentText();
    const run = (rules: PolicyRules): Answer => {
      const filtered = applyPolicy({ tool: input.tool, items: sample.items, rules });
      return { items: filtered.items, raw: [], warnings: filtered.warnings };
    };
    beforeAnswer = run(before);
    afterAnswer = run(after);
  } else {
    beforeAnswer = await runTool(deps, input.tool, before);
    afterAnswer = await runTool(deps, input.tool, after);
  }
  if (beforeAnswer === null || afterAnswer === null) return null;
  const left = onlyType(beforeAnswer, input.resourceType);
  const right = onlyType(afterAnswer, input.resourceType);

  let affected = 0;
  let sampleIndex = -1;
  for (const [index, item] of left.items.entries()) {
    const changed =
      !same(item, right.items.at(index)) || !same(left.raw.at(index), right.raw.at(index));
    if (!changed) continue;
    affected += 1;
    if (sampleIndex < 0) sampleIndex = index;
  }

  const index = Math.max(sampleIndex, 0);
  const beforeItem = left.items.at(index);
  const rawBefore = left.raw.at(index);
  const rawAfter = right.raw.at(index);
  return {
    tool: input.tool,
    total: left.items.length,
    affected,
    sample:
      beforeItem === undefined
        ? null
        : {
            before: beforeItem,
            after: right.items.at(index),
            ...(rawBefore !== undefined && { rawBefore: rawBefore.resource }),
            ...(rawAfter !== undefined && { rawAfter: rawAfter.resource }),
          },
    warnings: addedWarnings(beforeAnswer.warnings, afterAnswer.warnings),
    synthetic,
  };
}
