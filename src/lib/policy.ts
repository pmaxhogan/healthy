// The exposure-policy rule builder's logic, kept out of the components so it can
// be tested without mounting anything.
//
//   - the field TREE: the schema's shapes and datatypes expanded into picker
//     nodes, with the owner's real key structure overlaid (names only);
//   - the rule SENTENCE: "Hide participants → name in get_appointments at all
//     health systems";
//   - the preview DIFF: a before value drawn as lines, removed keys marked.
//
// Paths are built and read with the same grammar the Worker enforces
// (`shared/policy-path.ts`), so the path a node stands for is the path saved.

import { ARRAY_SEGMENT, humanPath, parsePath } from "@shared/policy-path.ts";

import type {
  FieldRuleSpec,
  PolicyFieldNode,
  PolicyKeyNode,
  PolicyRuleDto,
  PolicySchemaDto,
  PolicyShapeDto,
} from "@shared/types.ts";

// --- the tree ---------------------------------------------------------------

/** One pickable node. `path` is the canonical path it stands for. */
interface TreeNode {
  path: string;
  name: string;
  description: string | undefined;
  /** The value is an array; picking under it applies to every element. */
  array: boolean;
  /** Structure below is not modelled; the raw-path input can go deeper. */
  open: boolean;
  /** Withheld by default: an allow rule can put it back. */
  sensitive: boolean;
  /** Seen in the owner's own cached data (`structure`), by name only. */
  seen: boolean;
  /** Only in the owner's data: the model does not know it. */
  observedOnly: boolean;
  children: TreeNode[];
}

/** One top-level group: a shape a tool answers with. */
export interface TreeGroup {
  id: string;
  label: string;
  vocabulary: "normalized" | "raw";
  resourceType: string | null;
  nodes: TreeNode[];
}

/** How deep the tree is expanded. Deeper paths go in the raw-path input. */
const MAX_DEPTH = 8;

function childPath(parent: string, parentArray: boolean, name: string): string {
  if (parent === "") return name;
  return `${parent}${parentArray ? ARRAY_SEGMENT : ""}.${name}`;
}

interface Expand {
  datatypes: ReadonlyMap<string, readonly PolicyFieldNode[]>;
  /** Datatypes already open on the way down: a cycle guard (Reference -> Identifier -> Reference). */
  ancestry: readonly string[];
  depth: number;
}

function toTreeNode(
  field: PolicyFieldNode,
  parent: string,
  parentArray: boolean,
  ctx: Expand,
): TreeNode {
  const path = childPath(parent, parentArray, field.name);
  const array = field.array === true;
  let children: TreeNode[] = [];
  const type = field.type;
  if (field.children !== undefined) {
    children = field.children.map((child) =>
      toTreeNode(child, path, array, { ...ctx, depth: ctx.depth + 1 }),
    );
  } else if (type !== undefined && ctx.depth < MAX_DEPTH && !ctx.ancestry.includes(type)) {
    const fields = ctx.datatypes.get(type) ?? [];
    const next: Expand = { ...ctx, ancestry: [...ctx.ancestry, type], depth: ctx.depth + 1 };
    children = fields.map((child) => toTreeNode(child, path, array, next));
  }
  return {
    path,
    name: field.name,
    description: field.description,
    array,
    open: field.open === true,
    sensitive: field.sensitive === true,
    seen: false,
    observedOnly: false,
    children,
  };
}

/** The shapes a scope reaches, in the order the builder shows them. */
export function shapesFor(
  schema: PolicySchemaDto,
  scope: { tool: string | null; resourceType: string | null },
): PolicyShapeDto[] {
  const toolShapes =
    scope.tool === null
      ? null
      : new Set(schema.tools.find((tool) => tool.name === scope.tool)?.shapes);
  const inTool = (id: string): boolean => toolShapes === null || toolShapes.has(id);
  const ofType = (type: string | null): boolean =>
    scope.resourceType === null || type === scope.resourceType;
  return schema.shapes.filter((shape) => inTool(shape.id) && ofType(shape.resourceType));
}

/** The picker's groups for one scope, straight from the schema. */
export function buildTree(
  schema: PolicySchemaDto,
  scope: { tool: string | null; resourceType: string | null },
): TreeGroup[] {
  const datatypes = new Map(schema.datatypes.map((entry) => [entry.name, entry.fields]));
  return shapesFor(schema, scope).map((shape) => ({
    id: shape.id,
    label: shape.label,
    vocabulary: shape.vocabulary,
    resourceType: shape.resourceType,
    nodes: shape.fields.map((field) =>
      toTreeNode(field, "", false, { datatypes, ancestry: [], depth: 0 }),
    ),
  }));
}

/** Overlay observed key names on some nodes: mark the known ones, add the unknown ones. */
function overlayNodes(
  nodes: TreeNode[],
  observed: readonly PolicyKeyNode[],
  parent: string,
  parentArray: boolean,
): TreeNode[] {
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const out = [...nodes];
  for (const key of observed) {
    let node = byName.get(key.name);
    if (node === undefined) {
      node = {
        path: childPath(parent, parentArray, key.name),
        name: key.name,
        description: undefined,
        array: key.array === true,
        open: false,
        sensitive: false,
        seen: true,
        observedOnly: true,
        children: [],
      };
      out.push(node);
    }
    node.seen = true;
    if (key.children !== undefined) {
      node.children = overlayNodes(node.children, key.children, node.path, node.array);
    }
  }
  return out;
}

/**
 * The owner's real key structure laid over the tree: normalized-vocabulary
 * groups get the answer's item keys, raw groups the raw resource's keys.
 * Returns new groups; names only ever came from the server, never values.
 */
export function overlayStructure(
  groups: readonly TreeGroup[],
  structure: { item: readonly PolicyKeyNode[]; raw: readonly PolicyKeyNode[] },
): TreeGroup[] {
  return groups.map((group) => ({
    ...group,
    nodes: overlayNodes(
      cloneNodes(group.nodes),
      group.vocabulary === "raw" ? structure.raw : structure.item,
      "",
      false,
    ),
  }));
}

function cloneNodes(nodes: readonly TreeNode[]): TreeNode[] {
  return nodes.map((node) => ({ ...node, children: cloneNodes(node.children) }));
}

/** One row of the tree as drawn: a node, how deep, and whether it can open. */
export interface TreeRow {
  node: TreeNode;
  depth: number;
  group: string;
  expandable: boolean;
  expanded: boolean;
}

function matches(node: TreeNode, needle: string): boolean {
  return (
    node.path.toLowerCase().includes(needle) ||
    (node.description?.toLowerCase().includes(needle) ?? false)
  );
}

/** Every node below `nodes` that matches, and the ancestors that lead to one. */
function matchingPaths(nodes: readonly TreeNode[], needle: string, into: Set<string>): boolean {
  let any = false;
  for (const node of nodes) {
    const below = matchingPaths(node.children, needle, into);
    if (!(below || matches(node, needle))) {
      continue;
    }

    into.add(node.path);
    any = true;
  }
  return any;
}

/**
 * The rows to draw. With no search, children show under an expanded node; with
 * a search, every match and the ancestors leading to it show, opened.
 */
export function visibleRows(
  group: TreeGroup,
  expanded: ReadonlySet<string>,
  search: string,
): TreeRow[] {
  const needle = search.trim().toLowerCase();
  const shown = new Set<string>();
  if (needle !== "") matchingPaths(group.nodes, needle, shown);
  const rows: TreeRow[] = [];
  const walk = (nodes: readonly TreeNode[], depth: number): void => {
    for (const node of nodes) {
      if (needle !== "" && !shown.has(node.path)) continue;
      const open =
        needle === ""
          ? expanded.has(`${group.id}|${node.path}`)
          : node.children.some((child) => shown.has(child.path));
      rows.push({
        node,
        depth,
        group: group.id,
        expandable: node.children.length > 0,
        expanded: open,
      });
      if (open) walk(node.children, depth + 1);
    }
  };
  walk(group.nodes, 0);
  return rows;
}

/** Every path in some groups, for the raw-path input's autocomplete. */
export function allPaths(groups: readonly TreeGroup[]): string[] {
  const out = new Set<string>();
  const walk = (nodes: readonly TreeNode[]): void => {
    for (const node of nodes) {
      out.add(node.path);
      if (node.array) out.add(`${node.path}${ARRAY_SEGMENT}`);
      walk(node.children);
    }
  };
  for (const group of groups) walk(group.nodes);
  return [...out].toSorted((a, b) => a.localeCompare(b));
}

// --- sentences --------------------------------------------------------------

/** A path as the owner reads it: `participants → name`. */
export function readablePath(path: string): string {
  const parsed = parsePath(path);
  return parsed.ok ? humanPath(parsed.segments) : path;
}

function list(parts: readonly string[]): string {
  return parts.length <= 1
    ? parts.join("")
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`;
}

/** Where a field rule applies, as the end of a sentence. */
function whereClause(spec: FieldRuleSpec, healthSystemName: (id: string) => string): string {
  const what = spec.resourceType === null ? "" : ` on ${spec.resourceType} items`;
  const tool = spec.tool === null ? " in every tool" : ` in ${spec.tool}`;
  const at =
    spec.healthSystemId === null
      ? " at all health systems"
      : ` at ${healthSystemName(spec.healthSystemId)}`;
  return `${what}${tool}${at}`;
}

/** A field rule as one sentence. */
export function fieldSentence(
  spec: FieldRuleSpec,
  healthSystemName: (id: string) => string,
): string {
  const paths = list(spec.paths.map((path) => readablePath(path)));
  const verb = spec.effect === "allow" ? "Show" : "Hide";
  const tail = spec.effect === "allow" ? " (withheld by default)" : "";
  return `${verb} ${paths}${tail}${whereClause(spec, healthSystemName)}`;
}

/** Any rule as one sentence. */
export function ruleSentence(
  rule: PolicyRuleDto,
  healthSystemName: (id: string) => string,
): string {
  switch (rule.ruleType) {
    case "tool": {
      return `Block the tool ${rule.target}`;
    }
    case "resource": {
      return `Hide every ${rule.target} record, in every tool`;
    }
    case "health_system": {
      return `Hide everything from ${healthSystemName(rule.target)}`;
    }
    case "field": {
      return rule.field === null
        ? `Hide ${rule.target}`
        : fieldSentence(rule.field, healthSystemName);
    }
  }
}

/** The group a rule is listed under. */
export function ruleGroup(rule: PolicyRuleDto): string {
  switch (rule.ruleType) {
    case "tool": {
      return "Blocked tools";
    }
    case "resource": {
      return "Hidden resource types";
    }
    case "health_system": {
      return "Hidden health systems";
    }
    case "field": {
      if (rule.field?.tool != null) return `Fields in ${rule.field.tool}`;
      return rule.field?.resourceType == null
        ? "Fields in every tool"
        : `Fields on ${rule.field.resourceType}`;
    }
  }
}

/** The tools a rule changes the answers of, from the schema's tool shapes. */
export function toolsAffected(rule: PolicyRuleDto, schema: PolicySchemaDto | null): string[] {
  if (rule.ruleType === "tool") return [rule.target];
  const tool = rule.ruleType === "field" ? (rule.field?.tool ?? null) : null;
  if (tool !== null) return [tool];
  const resourceType =
    rule.ruleType === "resource" ? rule.target : (rule.field?.resourceType ?? null);
  if (schema === null || resourceType === null || rule.ruleType === "health_system") {
    return schema?.tools.map((entry) => entry.name) ?? [];
  }
  const typed = new Set(
    schema.shapes.filter((shape) => shape.resourceType === resourceType).map((shape) => shape.id),
  );
  // A resource rule also takes the type's rows out of the summary's counts and
  // the sync status, which name types without carrying their records.
  const rows = new Set(rule.ruleType === "resource" ? ROWS_NAMING_A_TYPE : []);
  return schema.tools
    .filter((entry) => rows.has(entry.name) || entry.shapes.some((shape) => typed.has(shape)))
    .map((entry) => entry.name);
}

/** Tools whose answer carries rows that name a resource type. */
const ROWS_NAMING_A_TYPE = ["get_health_summary", "get_sync_status"];

// --- the preview diff ---------------------------------------------------------

/** One line of a drawn JSON value. `removed` lines are what the rule takes out. */
export interface DiffLine {
  indent: number;
  text: string;
  removed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Where one value is drawn: its depth, its `"key": ` prefix, its trailing comma. */
interface Place {
  indent: number;
  prefix: string;
  comma: string;
  /** Already inside something removed: everything below is removed too. */
  removed: boolean;
}

/** An array or object's opening line, children, and closing line. */
function container(
  lines: DiffLine[],
  place: Place,
  brackets: [string, string],
  children: { value: unknown; other: unknown; prefix: string; gone: boolean }[],
): void {
  const { indent, prefix, comma, removed } = place;
  if (children.length === 0) {
    lines.push({ indent, text: `${prefix}${brackets.join("")}${comma}`, removed });
    return;
  }
  lines.push({ indent, text: `${prefix}${brackets[0]}`, removed });
  for (const [index, child] of children.entries()) {
    emit(lines, child.value, child.other, {
      indent: indent + 1,
      prefix: child.prefix,
      comma: index < children.length - 1 ? "," : "",
      removed: removed || child.gone,
    });
  }
  lines.push({ indent, text: `${brackets[1]}${comma}`, removed });
}

function emit(lines: DiffLine[], value: unknown, other: unknown, place: Place): void {
  if (Array.isArray(value)) {
    const others = Array.isArray(other) ? (other as unknown[]) : [];
    const elements = (value as unknown[]).map((element, index) => ({
      value: element,
      other: others.at(index),
      prefix: "",
      gone: index >= others.length,
    }));
    container(lines, place, ["[", "]"], elements);
    return;
  }
  if (isRecord(value)) {
    const otherRecord = isRecord(other) ? other : {};
    const entries = Object.entries(value).map(([key, child]) => {
      const kept = Object.hasOwn(otherRecord, key);
      return {
        value: child,
        other: kept ? Reflect.get(otherRecord, key) : undefined,
        prefix: `${JSON.stringify(key)}: `,
        gone: !kept,
      };
    });
    container(lines, place, ["{", "}"], entries);
    return;
  }
  const text = `${place.prefix}${JSON.stringify(value)}${place.comma}`;
  lines.push({ indent: place.indent, text, removed: place.removed });
}

/**
 * `value` drawn as JSON lines, with every key (or array element) that is not
 * in `other` marked. With `value` the item before a hide rule and `other` the
 * item after it, the marked lines are exactly what the rule removes; the other
 * way round, what an allow rule puts back.
 */
export function diffLines(value: unknown, other: unknown): DiffLine[] {
  const lines: DiffLine[] = [];
  emit(lines, value, other, { indent: 0, prefix: "", comma: "", removed: false });
  return lines;
}
