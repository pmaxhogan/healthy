// Pure-function coverage for src/lib/json-schema-completion.ts: the tokenizer
// and stack machine are exercised indirectly, through analyzePosition and the
// three sources built on top of it, the same seam JsonEditor.vue is wired
// against.
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import {
  analyzePosition,
  describeType,
  jsonSchemaCompletionSource,
  jsonSchemaHoverSource,
  resolveSchema,
  schemaDiagnostics,
} from "../../src/lib/json-schema-completion.ts";

import type { JsonSchema } from "../../src/lib/json-schema-completion.ts";
import type { CompletionResult, CompletionSource } from "@codemirror/autocomplete";

const TOOL_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    healthSystem: { type: "string", minLength: 1, description: "A health system id." },
    id: { type: "string", description: "The record id." },
    raw: { type: "boolean", description: "Also return the raw FHIR resource." },
    status: { type: "string", enum: ["active", "cancelled"], description: "Filter by status." },
    limit: { type: "number", description: "Maximum items to return." },
    items: {
      type: "array",
      description: "Nested items.",
      items: {
        type: "object",
        properties: { foo: { type: "string", description: "A nested string." } },
        additionalProperties: false,
      },
    },
  },
  required: ["healthSystem", "id"],
  additionalProperties: false,
};

function stateFor(doc: string): EditorState {
  return EditorState.create({ doc });
}

function contextAt(doc: string, pos: number, explicit = false): CompletionContext {
  return new CompletionContext(stateFor(doc), pos, explicit);
}

/** The sources in this module are always synchronous; unwrap that for the tests. */
function complete(source: CompletionSource, context: CompletionContext): CompletionResult | null {
  const result = source(context);
  if (result instanceof Promise) throw new TypeError("expected a synchronous completion result");
  return result;
}

describe("resolveSchema", () => {
  it("resolves a top-level property", () => {
    expect(resolveSchema(TOOL_SCHEMA, ["healthSystem"])).toEqual(
      TOOL_SCHEMA.properties?.healthSystem,
    );
  });

  it("resolves through an array's items", () => {
    expect(resolveSchema(TOOL_SCHEMA, ["items", "0", "foo"])).toEqual({
      type: "string",
      description: "A nested string.",
    });
  });

  it("returns undefined for a property additionalProperties forbids", () => {
    expect(resolveSchema(TOOL_SCHEMA, ["bogus"])).toBeUndefined();
    expect(resolveSchema(TOOL_SCHEMA, ["items", "0", "bar"])).toBeUndefined();
  });
});

describe("describeType", () => {
  it("labels a plain type", () => {
    expect(describeType({ type: "string" })).toBe("string");
  });

  it("labels an enum and a const distinctly from their underlying type", () => {
    expect(describeType({ type: "string", enum: ["a", "b"] })).toBe("enum");
    expect(describeType({ type: "string", const: "a" })).toBe("const");
  });

  it("falls back to 'any' with no declared type", () => {
    expect(describeType({})).toBe("any");
  });
});

describe("analyzePosition", () => {
  it("is a key position right after an opening brace", () => {
    const position = analyzePosition("{}", 1);
    expect(position.kind).toBe("key");
    if (position.kind !== "key") throw new Error("expected key");
    expect(position.containerPath).toEqual([]);
    expect(position.existingKeys.size).toBe(0);
  });

  it("is a key position while typing an unterminated key string", () => {
    const doc = '{"heal';
    const position = analyzePosition(doc, doc.length);
    expect(position.kind).toBe("key");
    if (position.kind !== "key") throw new Error("expected key");
    expect(position.quoted).toBe(true);
    expect(position.from).toBe(2); // right after the opening quote
  });

  it("is a value position right after a colon, scoped to that property's path", () => {
    const doc = '{"healthSystem":';
    const position = analyzePosition(doc, doc.length);
    expect(position.kind).toBe("value");
    if (position.kind !== "value") throw new Error("expected value");
    expect(position.path).toEqual(["healthSystem"]);
  });

  it("is a key position inside a nested object", () => {
    const doc = '{"items":[{';
    const position = analyzePosition(doc, doc.length);
    expect(position.kind).toBe("key");
    if (position.kind !== "key") throw new Error("expected key");
    expect(position.containerPath).toEqual(["items", "0"]);
  });

  it("declines to offer a key when a colon already follows", () => {
    const doc = '{"health":""}';
    // Cursor placed inside the already-closed key, before its colon.
    const position = analyzePosition(doc, 8);
    expect(position.kind).toBe("none");
  });

  it("flags that a trailing comma is needed before a sibling key", () => {
    const doc = '{"id":""}';
    // Cursor right after the opening brace, with an existing sibling after it.
    const position = analyzePosition(doc, 1);
    expect(position.kind).toBe("key");
    if (position.kind !== "key") throw new Error("expected key");
    expect(position.needsTrailingComma).toBe(true);
  });

  it("does not need a trailing comma when it is the last property", () => {
    const doc = "{}";
    const position = analyzePosition(doc, 1);
    expect(position.kind).toBe("key");
    if (position.kind !== "key") throw new Error("expected key");
    expect(position.needsTrailingComma).toBe(false);
  });

  it("stops the replacement range at the cursor, not at the end of a swallowed '}'", () => {
    // Typing '"' right after the '{' of an empty skeleton inserts an
    // unterminated string that -- per JSON's own grammar -- extends all the
    // way to the '}' with nothing to stop it: the whole rest of the line
    // reads as that string's content until a real closing quote appears. The
    // '}' is not something the owner typed as part of the key, so `to` must
    // stop at the cursor rather than swallow it.
    const doc = '{"}';
    const position = analyzePosition(doc, 2);
    expect(position.kind).toBe("key");
    if (position.kind !== "key") throw new Error("expected key");
    expect(position.from).toBe(2);
    expect(position.to).toBe(2);
    expect(position.needsTrailingComma).toBe(false);
  });
});

describe("jsonSchemaCompletionSource", () => {
  const source = jsonSchemaCompletionSource(() => TOOL_SCHEMA);

  it("lists the schema's properties with required ones first", () => {
    const result = complete(source, contextAt("{}", 1, true));
    expect(result).not.toBeNull();
    const labels = result?.options.map((option) => option.label) ?? [];
    expect(labels[0]).toBe("healthSystem");
    expect(labels[1]).toBe("id");
    expect(labels).toEqual(expect.arrayContaining(["raw", "status", "limit", "items"]));

    const healthSystem = result?.options.find((option) => option.label === "healthSystem");
    expect(healthSystem?.detail).toContain("required");
    const raw = result?.options.find((option) => option.label === "raw");
    expect(raw?.detail).toContain("optional");
  });

  it("excludes a key the object already has", () => {
    const doc = '{"healthSystem":"","}';
    const result = complete(source, contextAt(doc, doc.length - 1, true));
    const labels = result?.options.map((option) => option.label) ?? [];
    expect(labels).not.toContain("healthSystem");
    expect(labels).toContain("id");
  });

  it("offers completions when typing the very first quote into an empty skeleton", () => {
    // Regression test: typing '"' right after '{' in an empty `{}` skeleton
    // used to make the unterminated string swallow the '}' as content, which
    // made the replacement range extend past the cursor and, in a real editor,
    // silently produced zero completions (CodeMirror's own fuzzy matcher
    // rejects every label against text that includes a stray '}').
    const doc = '{"}';
    const result = complete(source, contextAt(doc, 2, true));
    expect(result).not.toBeNull();
    expect(result?.from).toBe(2);
    expect(result?.to).toBe(2);
    const labels = result?.options.map((option) => option.label) ?? [];
    expect(labels).toEqual(expect.arrayContaining(["healthSystem", "id"]));
  });

  it("produces a snippet that stays valid JSON when a sibling follows", () => {
    const doc = '{"id":""}';
    const result = complete(source, contextAt(doc, 1, true));
    const healthSystem = result?.options.find((option) => option.label === "healthSystem");
    expect(healthSystem).toBeDefined();
    const apply = healthSystem?.apply;
    expect(typeof apply).toBe("function");
    if (typeof apply !== "function" || healthSystem === undefined)
      throw new Error("expected a snippet completion");

    // snippetCompletion's `apply` performs a real dispatch on the view, so
    // exercising it end to end is the only way to see the resulting document.
    const view = new EditorView({ state: stateFor(doc) });
    apply(view, healthSystem, 1, 1);
    expect(view.state.doc.toString()).toBe('{"healthSystem": "","id":""}');
    view.destroy();
  });

  it("offers enum values at a value position", () => {
    const doc = '{"status":"';
    const result = complete(source, contextAt(doc, doc.length, true));
    const labels = result?.options.map((option) => option.label) ?? [];
    expect(labels).toEqual(["active", "cancelled"]);
  });

  it("offers true/false for a boolean value position", () => {
    const doc = '{"raw":';
    const result = complete(source, contextAt(doc, doc.length, true));
    const labels = result?.options.map((option) => option.label) ?? [];
    expect(labels).toEqual(["true", "false"]);
  });

  it("completes inside a nested array of objects", () => {
    const doc = '{"items":[{"';
    const result = complete(source, contextAt(doc, doc.length, true));
    const labels = result?.options.map((option) => option.label) ?? [];
    expect(labels).toEqual(["foo"]);
  });

  it("returns null outside any completable position", () => {
    expect(complete(source, contextAt("", 0, true))).toBeNull();
  });
});

describe("jsonSchemaHoverSource", () => {
  it("shows a property's description and type on its key", () => {
    const hover = jsonSchemaHoverSource(() => TOOL_SCHEMA);
    const doc = '{"healthSystem":""}';
    const view = new EditorView({ state: stateFor(doc) });
    const tooltip = hover(view, 5);
    expect(tooltip).not.toBeNull();
    const dom = tooltip?.create(view).dom;
    expect(dom?.textContent).toContain("healthSystem");
    expect(dom?.textContent).toContain("string");
    expect(dom?.textContent).toContain("A health system id.");
    view.destroy();
  });

  it("returns null off of any key", () => {
    const hover = jsonSchemaHoverSource(() => TOOL_SCHEMA);
    const doc = '{"healthSystem":""}';
    const view = new EditorView({ state: stateFor(doc) });
    expect(hover(view, doc.length - 1)).toBeNull();
    view.destroy();
  });
});

describe("schemaDiagnostics", () => {
  it("is empty for a valid document", () => {
    const doc = JSON.stringify({ healthSystem: "a", id: "b" });
    expect(schemaDiagnostics(TOOL_SCHEMA, doc)).toEqual([]);
  });

  it("flags an unknown field at its own range", () => {
    const doc = '{"healthSystem":"a","id":"b","bogus":1}';
    const diagnostics = schemaDiagnostics(TOOL_SCHEMA, doc);
    expect(diagnostics.length).toBeGreaterThan(0);
    const bogusStart = doc.indexOf('"bogus"');
    const flagged = diagnostics.find((d) => d.from >= bogusStart && d.to <= doc.indexOf("}"));
    expect(flagged).toBeDefined();
    expect(flagged?.severity).toBe("error");
  });

  it("flags a wrong-typed field at the value's own range", () => {
    const doc = '{"healthSystem":"a","id":"b","limit":"not-a-number"}';
    const diagnostics = schemaDiagnostics(TOOL_SCHEMA, doc);
    const valueStart = doc.indexOf('"not-a-number"');
    const flagged = diagnostics.find(
      (d) => d.from === valueStart && d.to === valueStart + '"not-a-number"'.length,
    );
    expect(flagged).toBeDefined();
    expect(flagged?.message.toLowerCase()).toContain("type");
  });

  it("reports a single diagnostic for invalid JSON", () => {
    const diagnostics = schemaDiagnostics(TOOL_SCHEMA, "{ not json");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe("error");
  });

  it("returns nothing with no schema yet", () => {
    expect(schemaDiagnostics(null, "{}")).toEqual([]);
  });
});
