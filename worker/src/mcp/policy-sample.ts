/**
The rule builder's two windows onto real data: the key structure of a tool's
answer, and a before/after preview of a draft `field` rule.

Both run the REAL tool, through the same in-memory MCP server the admin
console's "Try a tool" panel uses (`admin-call.ts`) -- so the sample is
exactly what an assistant would be handed, summary sections, portal visits
and raw resources included, not a second rendering of it that could drift.
What differs is the rule set the tool runs under, supplied here instead of
read from `mcp_policy`, and three things a preview must not do:

 - It writes no audit row. The audit log is what linked clients (and the
   owner, trying a tool) were answered; a preview, recomputed on every edit
   of a draft, is neither, and would bury the rows that matter.
 - It answers even while the MCP switch is off, so rules can be built before
   the surface is opened.
 - It never samples `get_document_text`, which is the one tool that can spend
   a health system's metered document quota. Its preview runs the draft over a
   made-up item of the tool's shape instead, and says so (`synthetic`).
 - It never runs `sync_health_systems`, the one tool that acts: a preview is
   recomputed on every keystroke of a draft, and must not be able to start a
   sync or spend a cooldown. That tool is previewed on a made-up item too,
   and locked out twice over: `runTool` refuses it, and the dependencies every
   sample runs with (`sampleDeps`) can neither claim a slot nor start a run.

The baseline a draft is compared against is the owner's stored `resource` and
`health_system` rules -- what decides which items exist at all -- and none of
the `tool` or `field` rules: the diff shows the draft's own effect, on a tool
the owner may already have switched off.

Nothing here logs a value. What leaves is the admin API's response, to the
owner's own browser, behind Access, the password session and the CSRF check.
*/

import { DAY_SECONDS, toIso } from "../lib/time.ts";
import { applyPolicy } from "../policy/filter.ts";
import { hcRuleCanReach, hcTypeOf, isHcResourceType } from "../policy/hc-aliases.ts";
import { EMPTY_RULES, buildRules } from "../policy/rules.ts";
import { shapesForScope, toolShapes } from "../policy/tree.ts";

import { callMcpTool } from "./admin-call.ts";
import { TOOL_NAMES } from "./tool-names.ts";

import type { ToolDeps } from "./deps.ts";
import type { McpPolicyRow } from "../db/rows.ts";
import type { RawEntry } from "../policy/filter.ts";
import type { PolicyRules } from "../policy/rules.ts";
import type {
  FieldRuleSpec,
  PolicyKeyNode,
  PolicyPreviewDto,
  PolicyToolPreviewDto,
  PolicyStructureDto,
} from "@shared/types.ts";

/** The one reading tool never sampled for real. See the module comment. */
const METERED_TOOL = "get_document_text";

/** The one tool that acts. Never run from here; see the module comment. */
const ACTION_TOOL = "sync_health_systems";

/** The tools a sample never runs: their previews use a made-up item. */
const NEVER_RUN: ReadonlySet<string> = new Set([METERED_TOOL, ACTION_TOOL]);

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

/** What a sample's dependencies answer when asked to queue a run. */
function refuseToStart(): Promise<never> {
  return Promise.reject(new Error("a sample starts nothing"));
}

/**
Deps that run under `rules`, write no audit row, ignore the MCP switch, and
cannot make the sync engine do anything.
*/
function sampleDeps(deps: ToolDeps, rules: PolicyRules): ToolDeps {
  return {
    ...deps,
    mcpEnabled: () => Promise.resolve(true),
    rules: () => Promise.resolve(rules),
    recordAudit: () => Promise.resolve(),
    pruneAudit: () => Promise.resolve(),
    // A sample reads. Whatever tool it runs, it can take no cooldown slot and
    // queue no run.
    sync: {
      ...deps.sync,
      claim: () => Promise.resolve(false),
      startCalendarSync: refuseToStart,
      startFullRefresh: refuseToStart,
    },
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

/** How far back a Health Connect tool is sampled: a week holds a row of most things. */
const PHONE_SAMPLE_DAYS = 7;

/** The Health Connect tools that need a range to answer at all. */
const PHONE_RANGE_TOOLS: ReadonlySet<string> = new Set([
  "hc_records",
  "hc_aggregate",
  "hr_series",
  "hr_events",
  "sleep_sessions",
  "exercise_sessions",
  "blood_pressure",
  "daily_summary",
  "data_quality",
]);

/** The two that also need a record type. */
const PHONE_TYPED_TOOLS: ReadonlySet<string> = new Set(["hc_records", "hc_aggregate"]);

/** The type those two are sampled on when the rule names none: what a phone is likeliest to hold. */
const PHONE_DEFAULT_TYPE = "Steps";

/** What a `daily_summary` row is tagged as: not a record type a tool can be asked for. */
const PHONE_SUMMARY_TYPE = "hc:DailySummary";

/**
The record type to sample a typed Health Connect tool on: the one the rule
(or the structure request) is about, so that a rule on heart rate is
previewed on heart-rate records and not on whatever the default holds.
*/
function phoneSampleType(resourceType: string | undefined): string {
  if (resourceType === undefined || resourceType === PHONE_SUMMARY_TYPE) return PHONE_DEFAULT_TYPE;
  return isHcResourceType(resourceType) ? hcTypeOf(resourceType) : PHONE_DEFAULT_TYPE;
}

/** The range (and type) a Health Connect tool is sampled over. Nothing for any other tool. */
function phoneSampleArgs(
  tool: string,
  now: number,
  resourceType: string | undefined,
): Record<string, unknown> {
  if (!PHONE_RANGE_TOOLS.has(tool)) return {};
  return {
    start: toIso(now - PHONE_SAMPLE_DAYS * DAY_SECONDS),
    ...(PHONE_TYPED_TOOLS.has(tool) && { type: phoneSampleType(resourceType) }),
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

/**
Tools that cannot be called without an argument naming one record:
`get_message_thread` needs a `threadId`, and is sampled on the newest
conversation `get_messages` lists; `get_message_attachment` needs an
attachment id, and is sampled on the first attachment of the newest
conversation that has one.
*/
const NEEDS_RECORD: ReadonlySet<string> = new Set(["get_message_thread", "get_message_attachment"]);

/** The parsed first text block of a tool answer's `items`, or null. */
async function listItems(
  deps: ToolDeps,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown[] | null> {
  const result = await callMcpTool(deps, tool, args);
  const first = result?.content[0];
  if (result === null || result.isError === true || first?.type !== "text") return null;
  const payload: unknown = JSON.parse(first.text);
  const items = isRecord(payload) ? own(payload, "items") : undefined;
  return Array.isArray(items) ? (items as unknown[]) : null;
}

/** The array under `key` of every record in `values`, flattened. */
function under(values: readonly unknown[], key: string): unknown[] {
  const out: unknown[] = [];
  for (const value of values) {
    const found = isRecord(value) ? own(value, key) : undefined;
    if (Array.isArray(found)) out.push(...(found as unknown[]));
  }
  return out;
}

/** The first attachment id of one conversation, as get_message_thread reports it. */
async function firstAttachmentId(deps: ToolDeps, threadId: string): Promise<string | null> {
  const items = (await listItems(deps, "get_message_thread", { threadId })) ?? [];
  const attachments = under(under(items, "messages"), "attachments");
  for (const attachment of attachments) {
    const id = isRecord(attachment) ? own(attachment, "id") : undefined;
    if (typeof id === "string") return id;
  }
  return null;
}

/**
The arguments that name the record to sample, read from the listing tool's
first item. Listed under the rules' resource and health system denials only --
not a tool denial, and never a field rule:
a draft that hides the id must still be previewed on the same record as the
baseline it is compared with.
*/
async function recordArgs(
  deps: ToolDeps,
  tool: string,
  rules: PolicyRules,
  resourceType: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (!NEEDS_RECORD.has(tool)) {
    return { ...sampleArgs(tool), ...phoneSampleArgs(tool, deps.now(), resourceType) };
  }
  const idOnly = sampleDeps(deps, { ...rules, tools: new Set(), fields: [], allows: [] });
  const threads = (await listItems(idOnly, "get_messages", sampleArgs("get_messages"))) ?? [];
  const wanted = threads.find(
    (item) =>
      isRecord(item) && (tool === "get_message_thread" || own(item, "hasAttachments") === true),
  );
  const threadId = isRecord(wanted) ? own(wanted, "threadId") : undefined;
  if (typeof threadId !== "string") return null;
  if (tool === "get_message_thread") return { threadId };
  const attachmentId = await firstAttachmentId(idOnly, threadId);
  return attachmentId === null ? null : { attachmentId };
}

/** Run one tool under `rules`. Null when the tool does not exist or answered an error. */
async function runTool(
  deps: ToolDeps,
  tool: string,
  rules: PolicyRules,
  resourceType?: string,
): Promise<Answer | null> {
  if (NEVER_RUN.has(tool)) return null;
  const args = await recordArgs(deps, tool, rules, resourceType);
  if (args === null) return null;
  const result = await callMcpTool(sampleDeps(deps, rules), tool, args);
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

/** A made-up `sync_health_systems` item: the tool's shape, and nothing was asked for. */
function syntheticSyncRequest(): Answer {
  return {
    items: [
      {
        kind: "sync_request",
        healthSystem: "Example Health",
        healthSystemId: "example",
        sync: "ordinary",
        outcome: "would_start",
        code: "dry_run",
        nextAllowedAt: null,
        lastCompletedAt: "2026-01-01T00:00:00.000Z",
        lastRequestedAt: null,
        requestsToday: 0,
        dailyLimit: 12,
        cooldownSeconds: 900,
      },
    ],
    raw: [],
    warnings: [],
  };
}

/**
True when an item is one a rule on `resourceType` is about: an item of that
type, or -- for a phone's data -- a row of another type that carries that
type's data (a night's row, for a rule on heart rate).
*/
function ofType(tool: string, item: unknown, resourceType: string): boolean {
  const ownType = isRecord(item) ? own(item, "resourceType") : undefined;
  return (
    typeof ownType === "string" &&
    (ownType === resourceType ||
      (isHcResourceType(resourceType) &&
        isHcResourceType(ownType) &&
        hcRuleCanReach(tool, ownType, resourceType)))
  );
}

/** Keep only the items a resource type's rule is about (and, index-aligned, their raw entries). */
function onlyType(tool: string, answer: Answer, resourceType: string | undefined): Answer {
  if (resourceType === undefined) return answer;
  const items: unknown[] = [];
  const raw: RawEntry[] = [];
  for (const [index, item] of answer.items.entries()) {
    if (!ofType(tool, item, resourceType)) continue;
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
The key structure of one tool's real answer -- every key any item has, at
every depth, arrays marked. Names only: no value leaves this function.
Run with no rules at all, so a key the owner has already hidden still shows.
*/
export async function sampleStructure(
  deps: ToolDeps,
  tool: string,
  resourceType?: string,
): Promise<PolicyStructureDto | null> {
  if (NEVER_RUN.has(tool)) return { tool, items: 0, item: [], raw: [] };
  const answer = await runTool(deps, tool, EMPTY_RULES, resourceType);
  if (answer === null) return null;
  const sample = onlyType(tool, answer, resourceType);
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
The draft applied to an answer the baseline already filtered. For a `hide`
rule this is exactly the answer a run with the draft in place would give:
field rules only ever remove, and the answer's items still carry the
`resourceType`, `healthSystemId` and raw entries the rule's scope is judged by.
*/
function applyDraft(tool: string, answer: Answer, draft: PolicyRules): Answer {
  const filtered = applyPolicy({ tool, items: answer.items, rawItems: answer.raw, rules: draft });
  return {
    items: filtered.items,
    raw: filtered.rawItems,
    warnings: [...answer.warnings, ...filtered.warnings],
  };
}

/** The draft's field rules on their own, with no whole-item denials. */
function draftOnly(rules: PolicyRules): PolicyRules {
  return { ...EMPTY_RULES, fields: rules.fields, allows: rules.allows };
}

/** One tool's answer before and after the draft. Null when the tool answered an error. */
async function beforeAndAfter(
  deps: ToolDeps,
  tool: string,
  field: FieldRuleSpec,
  stored: readonly McpPolicyRow[],
): Promise<{ before: Answer; after: Answer } | null> {
  const before = baselineRules(stored);
  const after = withDraft(stored, field);
  if (NEVER_RUN.has(tool)) {
    const sample = tool === ACTION_TOOL ? syntheticSyncRequest() : syntheticDocumentText();
    const run = (rules: PolicyRules): Answer => {
      const filtered = applyPolicy({ tool, items: sample.items, rules });
      return { items: filtered.items, raw: [], warnings: filtered.warnings };
    };
    return { before: run(before), after: run(after) };
  }
  const sampledType = field.resourceType ?? undefined;
  const beforeAnswer = await runTool(deps, tool, before, sampledType);
  if (beforeAnswer === null) return null;
  // An `allow` rule puts back a field the baseline run already stripped, which
  // only a run with the rule in place can show; a `hide` rule is applied to
  // the baseline answer, so each tool runs once.
  const afterAnswer =
    field.effect === "allow"
      ? await runTool(deps, tool, after, sampledType)
      : applyDraft(tool, beforeAnswer, draftOnly(after));
  return afterAnswer === null ? null : { before: beforeAnswer, after: afterAnswer };
}

/**
Run a draft rule over one tool's real answer and report what it changes.

The two answers line up item for item (a field rule never drops an item), so
the first item that differs is the sample, and the count of those that differ
is `affected`.
*/
async function previewOne(
  deps: ToolDeps,
  stored: readonly McpPolicyRow[],
  input: { tool: string; resourceType?: string | undefined; field: FieldRuleSpec },
): Promise<PolicyToolPreviewDto | null> {
  const synthetic = NEVER_RUN.has(input.tool);
  const answers = await beforeAndAfter(deps, input.tool, input.field, stored);
  if (answers === null) return null;
  const { before: beforeAnswer, after: afterAnswer } = answers;
  const left = onlyType(input.tool, beforeAnswer, input.resourceType);
  const right = onlyType(input.tool, afterAnswer, input.resourceType);

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

/**
The tools a draft is previewed on: the one it names, else every tool whose
answers its scope can reach. `get_document_text` only when it is named: its
sample is made up, so it says nothing about what the draft does to the
owner's data.
*/
function candidateTools(field: FieldRuleSpec, tool: string | undefined): string[] {
  const named = tool ?? field.tool;
  const reached = (name: string): boolean =>
    !NEVER_RUN.has(name) &&
    shapesForScope({ tool: name, resourceType: field.resourceType }).length > 0;
  return named === null ? TOOL_NAMES.filter((name) => reached(name)) : [named];
}

/**
A draft rule run over every tool its scope can reach, in one request: per
tool, how many items it changes out of how many, and the first one it
changes. The tools run one after another, not concurrently -- they share one
per-call cache in `deps`, which a parallel run would tear.
*/
export async function previewDraft(
  deps: ToolDeps,
  stored: readonly McpPolicyRow[],
  input: { tool?: string | undefined; resourceType?: string | undefined; field: FieldRuleSpec },
): Promise<PolicyPreviewDto> {
  const tools: PolicyToolPreviewDto[] = [];
  for (const tool of candidateTools(input.field, input.tool)) {
    const preview = await previewOne(deps, stored, {
      tool,
      resourceType: input.resourceType,
      field: input.field,
    });
    if (preview !== null) tools.push(preview);
  }
  return { tools };
}
