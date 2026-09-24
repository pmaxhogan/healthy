// Schema-driven completion, hover and lint for the sandboxed "Try a tool"
// arguments editor (src/components/JsonEditor.vue). The document being edited
// is one tool call's arguments -- small -- so this reparses it from scratch on
// every keystroke with a hand-rolled tokenizer rather than tracking
// incremental parser state. Simpler to get right, and cheap enough at this
// size.
//
// Why not the `codemirror-json-schema` package: its bundled feature set pulls
// in `shiki` (a ~10 MB syntax highlighter with a WASM oniguruma engine) and
// `markdown-it` (to render `description` as HTML) as transitive dependencies
// of its high-level API. Neither belongs in a single-file, CSP-locked sandbox
// (shared/mcp-sandbox.ts) that inlines every dependency into one HTML
// document and, by design, never renders untrusted HTML. This module gets the
// same three features -- completion, hover, lint -- from the schema alone,
// built on the official, dependency-free @codemirror/autocomplete and
// @codemirror/lint packages already used elsewhere in this app's CSP.
//
// ### How a position is classified
//
// Rather than walk the @lezer/json syntax tree -- which recovers well from
// *complete* JSON but is awkward to reason about for a document that is, by
// definition, usually mid-edit and often invalid -- this module tokenizes the
// document with a tiny scanner (`tokenize`) and replays the tokens through a
// stack machine (`walkTokens`) that tracks, for every open `{`/`[`, the JSON
// Pointer path to that container and which keys it has already seen. That
// gives every position in the document -- including inside an unterminated
// string -- an unambiguous "expecting a key here" or "expecting this path's
// value here" classification (`analyzePosition`), which the completion source
// and the hover source both resolve against the tool's JSON Schema the same
// way (`resolveSchema`). The lint source reuses the same walk in the other
// direction: given a JSON Pointer from a validation error, it looks up the
// text range that pointer names (`keyValueRanges`).

import { Validator } from "@cfworker/json-schema";
import { snippetCompletion } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";

import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import type { Diagnostic } from "@codemirror/lint";
import type { Tooltip } from "@codemirror/view";

/** The handful of JSON Schema keys this module reads. Anything else is ignored. */
export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema | JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Schema navigation
// ---------------------------------------------------------------------------

/** The subschema at one path segment, or `undefined` if the schema forbids it there. */
function propertySchema(schema: JsonSchema, key: string): JsonSchema | undefined {
  const properties = schema.properties;
  if (properties !== undefined && Object.hasOwn(properties, key)) return properties[key];
  const items = schema.items;
  if (items !== undefined) return Array.isArray(items) ? items[Number(key)] : items;
  const additional = schema.additionalProperties;
  if (additional === false) return undefined;
  return additional === undefined || additional === true ? {} : additional;
}

/**
 * Walks a JSON Pointer-shaped path (each segment either an object key or,
 * inside an array, the index as a string) to the subschema it names. Every
 * path this module builds comes from either the tokenizer's own walk of the
 * document or a validator's `instanceLocation`, so segments are always plain
 * strings even when they represent an array index.
 */
export function resolveSchema(root: JsonSchema, path: readonly string[]): JsonSchema | undefined {
  let current: JsonSchema | undefined = root;
  for (const segment of path) {
    if (current === undefined) return undefined;
    current = propertySchema(current, segment);
  }
  return current;
}

/** A short, human label for a schema's declared type(s). */
export function describeType(schema: JsonSchema): string {
  if (schema.const !== undefined) return "const";
  if (schema.enum !== undefined) return "enum";
  const type = schema.type;
  if (type === undefined) return "any";
  return Array.isArray(type) ? type.join(" | ") : type;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

interface PunctToken {
  kind: "punct";
  text: "{" | "}" | "[" | "]" | "," | ":";
  from: number;
  to: number;
}
interface StringToken {
  kind: "string";
  from: number;
  to: number;
  closed: boolean;
  value: string;
}
interface AtomToken {
  kind: "atom";
  from: number;
  to: number;
  text: string;
}
type Token = PunctToken | StringToken | AtomToken;

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const STOP_CHARS = new Set([" ", "\t", "\n", "\r", "{", "}", "[", "]", ",", ":", '"']);
const PUNCTUATION = new Set(["{", "}", "[", "]", ",", ":"]);

function isWhitespace(char: string): boolean {
  return WHITESPACE.has(char);
}

function isPunctuation(char: string): char is PunctToken["text"] {
  return PUNCTUATION.has(char);
}

function readString(doc: string, start: number): StringToken {
  let index = start + 1;
  let value = "";
  let closed = false;
  while (index < doc.length) {
    const char = doc.charAt(index);
    if (char === "\\" && index + 1 < doc.length) {
      value += doc.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (char === '"') {
      closed = true;
      index += 1;
      break;
    }
    if (char === "\n") break;
    value += char;
    index += 1;
  }
  return { kind: "string", from: start, to: index, closed, value };
}

function readAtom(doc: string, start: number): AtomToken {
  let index = start;
  while (index < doc.length && !STOP_CHARS.has(doc.charAt(index))) index += 1;
  return { kind: "atom", from: start, to: index, text: doc.slice(start, index) };
}

/** Splits `doc` into JSON tokens, tolerant of the invalid or incomplete text an in-progress edit produces. */
function tokenize(doc: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < doc.length) {
    const char = doc.charAt(index);
    if (isWhitespace(char)) {
      index += 1;
      continue;
    }
    if (isPunctuation(char)) {
      tokens.push({ kind: "punct", text: char, from: index, to: index + 1 });
      index += 1;
      continue;
    }
    if (char === '"') {
      const token = readString(doc, index);
      tokens.push(token);
      index = token.to;
      continue;
    }
    const token = readAtom(doc, index);
    tokens.push(token);
    index = token.to > index ? token.to : index + 1;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Stack machine: replays tokens into container paths and key/value ranges
// ---------------------------------------------------------------------------

interface ObjectFrame {
  kind: "object";
  path: readonly string[];
  openFrom: number;
  keys: Set<string>;
  pendingKey: string | null;
}
interface ArrayFrame {
  kind: "array";
  path: readonly string[];
  openFrom: number;
  count: number;
}
type Frame = ObjectFrame | ArrayFrame;

/** Path segments joined into one map key. `\u0000` cannot appear in a JSON string or a JSON Pointer segment. */
const PATH_SEP = "\u{0}";
function pathKey(path: readonly string[]): string {
  return path.join(PATH_SEP);
}

interface WalkResult {
  stack: Frame[];
  /** Full range (including both quotes) of each committed property-name string, by the path it names. */
  keyRanges: Map<string, { from: number; to: number }>;
  /** Full range of each committed value (primitive, or the whole of an object/array), by its own path. */
  valueRanges: Map<string, { from: number; to: number }>;
}

function currentValuePath(stack: readonly Frame[]): readonly string[] {
  const top = stack.at(-1);
  if (top === undefined) return [];
  if (top.kind === "array") return [...top.path, String(top.count)];
  return top.pendingKey === null ? top.path : [...top.path, top.pendingKey];
}

function openContainer(stack: Frame[], text: "{" | "[", from: number): void {
  const path = currentValuePath(stack);
  stack.push(
    text === "{"
      ? { kind: "object", path, openFrom: from, keys: new Set(), pendingKey: null }
      : { kind: "array", path, openFrom: from, count: 0 },
  );
}

function closeContainer(stack: Frame[], to: number, valueRanges: WalkResult["valueRanges"]): void {
  const closed = stack.pop();
  if (closed === undefined) return;
  valueRanges.set(pathKey(closed.path), { from: closed.openFrom, to });
  markValueCommitted(stack);
}

function markValueCommitted(stack: Frame[]): void {
  const top = stack.at(-1);
  if (top === undefined) return;
  if (top.kind === "object") top.pendingKey = null;
  else top.count += 1;
}

/** Replays `tokens` (a prefix or the whole document) through the stack machine. */
function walkTokens(tokens: readonly Token[]): WalkResult {
  const stack: Frame[] = [];
  const keyRanges: WalkResult["keyRanges"] = new Map();
  const valueRanges: WalkResult["valueRanges"] = new Map();

  for (const token of tokens) {
    if (token.kind === "punct") {
      if (token.text === "{" || token.text === "[") openContainer(stack, token.text, token.from);
      else if (token.text === "}" || token.text === "]")
        closeContainer(stack, token.to, valueRanges);
      // "," and ":" carry no state of their own: they only ever follow an
      // already-committed key or value.
      continue;
    }
    const top = stack.at(-1);
    if (token.kind === "string" && top?.kind === "object" && top.pendingKey === null) {
      top.pendingKey = token.value;
      top.keys.add(token.value);
      keyRanges.set(pathKey([...top.path, token.value]), { from: token.from, to: token.to });
      continue;
    }
    // A string in value position, or a number/true/false/null/garbage atom:
    // either way, it is a value.
    valueRanges.set(pathKey(currentValuePath(stack)), { from: token.from, to: token.to });
    markValueCommitted(stack);
  }
  return { stack, keyRanges, valueRanges };
}

/** The key and value text ranges for every property and item in `doc`, by their JSON Pointer-style path. */
function keyValueRanges(doc: string): Pick<WalkResult, "keyRanges" | "valueRanges"> {
  return walkTokens(tokenize(doc));
}

// ---------------------------------------------------------------------------
// Position analysis: what does completion mean right here?
// ---------------------------------------------------------------------------

export type PositionContext =
  | { kind: "none" }
  | {
      kind: "key";
      containerPath: readonly string[];
      existingKeys: ReadonlySet<string>;
      /** Whether a `,` must be appended after the inserted key/value pair to stay valid JSON. */
      needsTrailingComma: boolean;
      /** Whether an opening quote already precedes `from` (so the snippet must not add its own). */
      quoted: boolean;
      from: number;
      to: number;
    }
  | {
      kind: "value";
      path: readonly string[];
      quoted: boolean;
      gap: boolean;
      from: number;
      to: number;
    };

function splitAtPosition(
  tokens: readonly Token[],
  pos: number,
): { prior: Token[]; active: Token | null } {
  const prior: Token[] = [];
  for (const token of tokens) {
    if (pos > token.from && pos <= token.to) return { prior, active: token };
    if (token.from >= pos) return { prior, active: null };
    prior.push(token);
  }
  return { prior, active: null };
}

function peekSignificant(doc: string, from: number): string | null {
  let index = from;
  while (index < doc.length && isWhitespace(doc.charAt(index))) index += 1;
  return index < doc.length ? doc.charAt(index) : null;
}

interface ActiveClassification {
  range: { from: number; to: number };
  /** Whether an opening quote already precedes `range.from` (so a snippet must not add its own). */
  quoted: boolean;
  /** Whether there is no existing token here at all -- a bare insertion point. */
  gap: boolean;
  /** Whether this position could be a JSON object key (an unquoted atom never can be). */
  allowKey: boolean;
  /** Where to look, in the untouched document, for what a completion here would need a trailing comma before. */
  peekFrom: number;
}

/** What kind of token, if any, sits at `pos` -- and so what a completion there would need to replace. */
function classifyActive(active: Token | null, pos: number): ActiveClassification {
  if (active === null || active.kind === "punct") {
    return {
      range: { from: pos, to: pos },
      quoted: false,
      gap: true,
      allowKey: true,
      peekFrom: pos,
    };
  }
  if (active.kind === "string") {
    if (active.closed) {
      return {
        range: { from: active.from + 1, to: active.to - 1 },
        quoted: true,
        gap: false,
        allowKey: true,
        peekFrom: active.to,
      };
    }
    // An *unterminated* string swallows everything up to the next quote or
    // newline as "content" -- including a '}' or ',' that was never meant to
    // be part of it. Typing '"' right after '{' in an existing `{}` skeleton
    // is exactly this: the whole rest of the line (a real, structural '}')
    // reads as this string's content since there is no closing quote yet.
    // Only what is left of the cursor is the key/value actually being typed,
    // so the replacement -- and the search for what follows it -- stops at
    // the cursor, not at the token's own (over-extended) end.
    return {
      range: { from: active.from + 1, to: pos },
      quoted: true,
      gap: false,
      allowKey: true,
      peekFrom: pos,
    };
  }
  return {
    range: { from: active.from, to: active.to },
    quoted: false,
    gap: false,
    allowKey: false,
    peekFrom: active.to,
  };
}

/** Builds the "key" context for an object frame ready for its next key, or `none` when this slot is not one. */
function keyPositionContext(
  doc: string,
  top: ObjectFrame,
  peekFrom: number,
  range: { from: number; to: number },
  quoted: boolean,
): PositionContext {
  const trailing = peekSignificant(doc, peekFrom);
  // A ':' right after this position means it is really an *existing* key
  // whose value has already been (or is about to be) written -- not a slot to
  // insert a fresh "key": value pair into.
  if (trailing === ":") return { kind: "none" };
  const needsTrailingComma =
    trailing !== null && trailing !== "," && trailing !== "}" && trailing !== "]";
  return {
    kind: "key",
    containerPath: top.path,
    existingKeys: top.keys,
    needsTrailingComma,
    quoted,
    ...range,
  };
}

/** Classifies `pos` in `doc` as a key position, a value position (for a specific path), or neither. */
export function analyzePosition(doc: string, pos: number): PositionContext {
  const tokens = tokenize(doc);
  const { prior, active } = splitAtPosition(tokens, pos);

  const consumed = active !== null && active.kind === "punct" ? [...prior, active] : prior;
  const { stack } = walkTokens(consumed);
  const top = stack.at(-1);
  if (top === undefined) return { kind: "none" };

  const { range, quoted, gap, allowKey, peekFrom } = classifyActive(active, pos);

  if (top.kind === "object" && top.pendingKey === null) {
    return allowKey ? keyPositionContext(doc, top, peekFrom, range, quoted) : { kind: "none" };
  }
  if (top.kind === "object") {
    // The `pendingKey === null` case returned above, so this object frame is
    // awaiting a value for a known key.
    const key = top.pendingKey;
    return key === null
      ? { kind: "none" }
      : { kind: "value", path: [...top.path, key], quoted, gap, ...range };
  }
  return { kind: "value", path: [...top.path, String(top.count)], quoted, gap, ...range };
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/** Escapes text so it is safe to splice into a `snippetCompletion` template. */
function escapeForSnippet(text: string): string {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll("{", String.raw`\{`)
    .replaceAll("}", String.raw`\}`);
}

/** The snippet fragment for a property's value, spliced in right after `key": `. */
function valueSnippet(schema: JsonSchema | undefined): string {
  if (schema === undefined) return '"${1}"';
  if (schema.const !== undefined) {
    const constant = schema.const;
    return typeof constant === "string"
      ? `"\${1:${escapeForSnippet(constant)}}"`
      : `\${1:${escapeForSnippet(JSON.stringify(constant))}}`;
  }
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "boolean": {
      return "${1:false}";
    }
    case "number":
    case "integer": {
      return "${1:0}";
    }
    case "array": {
      return "[${1}]";
    }
    case "object": {
      return "{${1}}";
    }
    case "null": {
      return "null";
    }
    default: {
      return '"${1}"';
    }
  }
}

function propertyCompletion(
  key: string,
  schema: JsonSchema | undefined,
  required: boolean,
  needsTrailingComma: boolean,
  includeLeadingQuote: boolean,
): Completion {
  const quote = includeLeadingQuote ? '"' : "";
  const comma = needsTrailingComma ? "," : "";
  const template = `${quote}${escapeForSnippet(key)}": ${valueSnippet(schema)}${comma}`;
  const type = schema === undefined ? "any" : describeType(schema);
  return snippetCompletion(template, {
    label: key,
    type: "property",
    detail: `${type} · ${required ? "required" : "optional"}`,
    ...(schema?.description !== undefined && { info: schema.description }),
    boost: required ? 2 : 0,
    sortText: `${required ? "0" : "1"}${key}`,
  });
}

function keyCompletions(
  schema: JsonSchema,
  position: Extract<PositionContext, { kind: "key" }>,
): Completion[] {
  const containerSchema = resolveSchema(schema, position.containerPath);
  if (containerSchema === undefined) return [];
  const properties = containerSchema.properties ?? {};
  const required = new Set(containerSchema.required);
  const entries = Object.entries(properties).filter(([key]) => !position.existingKeys.has(key));
  entries.sort(([keyA], [keyB]) => {
    const requiredA = required.has(keyA);
    const requiredB = required.has(keyB);
    if (requiredA !== requiredB) return requiredA ? -1 : 1;
    return keyA.localeCompare(keyB);
  });
  return entries.map(([key, propertySchemaAt]) =>
    // The "key" position is always either mid an already-open quote
    // (`position.quoted`) or a bare gap with nothing typed yet -- never an
    // unquoted atom (see `analyzePosition`'s `allowKey` check) -- so a leading
    // quote is needed in exactly the non-quoted case.
    propertyCompletion(
      key,
      propertySchemaAt,
      required.has(key),
      position.needsTrailingComma,
      !position.quoted,
    ),
  );
}

function candidateValues(schema: JsonSchema): unknown[] {
  if (schema.const !== undefined) return [schema.const];
  if (schema.enum !== undefined) return schema.enum;
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  return type === "boolean" ? [true, false] : [];
}

function valueCompletion(value: unknown, quoted: boolean): Completion {
  const label = typeof value === "string" ? value : JSON.stringify(value);
  const insert = quoted ? JSON.stringify(value).slice(1, -1) : JSON.stringify(value);
  return {
    label,
    type: typeof value === "boolean" ? "keyword" : "constant",
    apply: insert,
  };
}

function valueCompletions(
  schema: JsonSchema,
  position: Extract<PositionContext, { kind: "value" }>,
): Completion[] {
  const valueSchemaAt = resolveSchema(schema, position.path);
  return valueSchemaAt === undefined
    ? []
    : candidateValues(valueSchemaAt)
        .filter((value) => position.gap || (typeof value === "string") === position.quoted)
        .map((value) => valueCompletion(value, position.quoted));
}

/**
 * A `@codemirror/autocomplete` completion source driven entirely by the
 * tool's JSON Schema: property names (required ones first) at key positions,
 * and enum/const/boolean literals at value positions. `getSchema` is read on
 * every call, not captured once, so a caller can swap the schema (a new tool
 * selected) without recreating the editor.
 */
export function jsonSchemaCompletionSource(getSchema: () => JsonSchema | null): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const schema = getSchema();
    if (schema === null) return null;
    const position = analyzePosition(context.state.doc.toString(), context.pos);
    if (position.kind === "none") return null;

    const options =
      position.kind === "key"
        ? keyCompletions(schema, position)
        : valueCompletions(schema, position);
    return options.length === 0 ? null : { from: position.from, to: position.to, options };
  };
}

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

function buildHoverDom(name: string, schema: JsonSchema): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-json-schema-hover";
  const title = document.createElement("div");
  title.className = "cm-json-schema-hover-title";
  title.textContent = `${name}: ${describeType(schema)}`;
  dom.append(title);
  if (schema.description !== undefined) {
    const description = document.createElement("div");
    description.className = "cm-json-schema-hover-desc";
    description.textContent = schema.description;
    dom.append(description);
  }
  return dom;
}

/**
 * A `hoverTooltip` source (see `@codemirror/view`) that shows a property's
 * description and type when the pointer rests on its key.
 */
export function jsonSchemaHoverSource(getSchema: () => JsonSchema | null) {
  return (view: EditorView, pos: number): Tooltip | null => {
    const schema = getSchema();
    if (schema === null) return null;
    const doc = view.state.doc.toString();
    const { keyRanges } = keyValueRanges(doc);
    for (const [key, range] of keyRanges) {
      if (pos < range.from || pos > range.to) continue;
      const path = key.split(PATH_SEP);
      const propertySchemaAt = resolveSchema(schema, path);
      if (propertySchemaAt === undefined) return null;
      const name = path.at(-1) ?? "";
      return {
        pos: range.from,
        end: range.to,
        above: true,
        create: () => ({ dom: buildHoverDom(name, propertySchemaAt) }),
      };
    }
    return null;
  };
}

// ---------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------

function decodePointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function parseErrorDiagnostic(doc: string, error: unknown): Diagnostic {
  const message = error instanceof Error ? error.message : "invalid JSON";
  const match = /position (\d+)/.exec(message);
  const from = match ? Math.min(Number(match[1]), Math.max(doc.length - 1, 0)) : 0;
  return { from, to: Math.min(from + 1, doc.length), severity: "error", message };
}

/**
 * Validates `doc` against `schema` and returns one lint diagnostic per
 * schema-validation error that names a specific key or value (skipping the
 * container-level errors the validator also reports for the same problem,
 * which have nothing of their own to underline). A JSON syntax error short-
 * circuits to a single diagnostic near the parse failure.
 *
 * A pure function -- `linter()`'s own delay and refresh timing wrap it; tests
 * call it directly.
 */
export function schemaDiagnostics(schema: JsonSchema | null, doc: string): Diagnostic[] {
  if (schema === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(doc);
  } catch (error) {
    return [parseErrorDiagnostic(doc, error)];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [{ from: 0, to: doc.length, severity: "error", message: "must be a JSON object" }];
  }

  // `Validator` wants its own, stricter `Schema` type (an exact `InstanceType`
  // literal union for `type`, among other things). `JsonSchema` is
  // deliberately looser -- it describes whatever a tool's real input schema
  // (`Tool["inputSchema"]`, itself just `Record<string, unknown>`) turns out
  // to carry -- so widen through that same `Record<string, unknown>` shape
  // rather than asserting the stricter one, matching how SandboxApp.vue's own
  // `Validator` call already treats a tool's schema.
  const validator = new Validator(schema as Record<string, unknown>, "7", false);
  const result = validator.validate(parsed);
  if (result.valid) return [];

  const { valueRanges } = keyValueRanges(doc);
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const issue of result.errors) {
    if (issue.instanceLocation === "#") continue; // a container-level error has no single token to underline
    const path = issue.instanceLocation
      .replace(/^#\//, "")
      .split("/")
      .map((segment) => decodePointerSegment(segment));
    const range = valueRanges.get(pathKey(path));
    if (range === undefined) continue;
    const dedupeKey = [range.from, range.to, issue.error].join(":");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    diagnostics.push({
      from: range.from,
      to: range.to,
      severity: "error",
      message: issue.error,
      source: "schema",
    });
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const MONOSPACE_FONT = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

/**
 * Styling for the completion popup, the hover tooltip and the lint markers,
 * layered on top of `jsonBaseExtensions()`'s theme (src/lib/codemirror-json.ts)
 * the same way that theme layers on top of CodeMirror's own: every colour is
 * one of this app's CSS custom properties, so both light and dark mode track
 * `prefers-color-scheme` with no JavaScript here to keep them in sync.
 *
 * `@codemirror/lint`'s base theme underlines an error with a `background-image`
 * data URI, which this editor's sandboxed CSP (`img-src 'none'`,
 * `worker/auth/security-headers.ts`'s `sandboxContentSecurityPolicy`) refuses to
 * load -- Chrome logs a CSP violation and shows no underline at all. Every
 * `.cm-lintRange*` rule below replaces that image with a plain
 * `text-decoration`, which needs no image.
 */
export const jsonSchemaCompletionTheme = EditorView.theme({
  ".cm-tooltip.cm-tooltip-autocomplete": {
    border: "1px solid var(--border)",
    borderRadius: "8px",
    overflow: "hidden",
    boxShadow: "var(--shadow)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    backgroundColor: "var(--bg-raised)",
    color: "var(--text)",
    fontFamily: MONOSPACE_FONT,
    fontSize: "0.85rem",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-text)",
  },
  ".cm-completionDetail": { color: "var(--text-dim)", fontStyle: "normal" },
  // `--text-dim` (the unselected row's detail colour) is a low-contrast grey
  // tuned against `--bg-raised`, not against `--accent` -- on the selected
  // row's teal background it was reading close to invisible (~1.6:1).
  // `--accent-selected-text` (src/style.css) is chosen for >=4.5:1 (WCAG AA,
  // body text) against `--accent` specifically -- unlike `--accent-text`
  // (the row's own label colour, immediately above), which is tuned for a
  // button's larger/bolder text and only clears ~3.75:1 in light mode.
  ".cm-tooltip-autocomplete ul li[aria-selected] .cm-completionDetail": {
    color: "var(--accent-selected-text)",
  },
  ".cm-tooltip.cm-completionInfo": {
    backgroundColor: "var(--bg-raised)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    padding: "6px 10px",
    boxShadow: "var(--shadow)",
  },
  ".cm-json-schema-hover": {
    backgroundColor: "var(--bg-raised)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    padding: "6px 10px",
    fontSize: "0.85rem",
    maxWidth: "320px",
  },
  ".cm-json-schema-hover-title": {
    fontFamily: MONOSPACE_FONT,
    color: "var(--accent)",
    marginBottom: "2px",
  },
  ".cm-json-schema-hover-desc": { color: "var(--text-dim)" },
  ".cm-diagnostic": {
    backgroundColor: "var(--bg-raised)",
    color: "var(--text)",
  },
  ".cm-diagnostic-error": { borderLeft: "5px solid var(--danger)" },
  ".cm-diagnostic-warning": { borderLeft: "5px solid var(--warn)" },
  ".cm-tooltip.cm-tooltip-lint": {
    border: "1px solid var(--border)",
    borderRadius: "8px",
    boxShadow: "var(--shadow)",
  },
  ".cm-lintRange": { backgroundImage: "none" },
  ".cm-lintRange-error": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--danger)",
  },
  ".cm-lintRange-warning": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--warn)",
  },
});
