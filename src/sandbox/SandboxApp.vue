<script setup lang="ts">
// The sandboxed half of "Try a tool": the argument editor and the request/result
// viewers, served from shared/mcp-sandbox.ts's MCP_SANDBOX_PATH and embedded by
// src/components/McpToolTester.vue in a `sandbox="allow-scripts"` iframe with no
// `allow-same-origin`. That gives this page an opaque origin -- no cookies, no
// session, no ability to call /api -- so everything it needs comes in over
// postMessage, and the one thing it cannot do for itself (the actual
// authenticated tool call) it asks the parent to do.
//
// Every message from the parent is validated twice before this page acts on it:
// by identity (`event.source === window.parent`, since an opaque origin's
// `event.origin` is the useless literal string "null") and by shape
// (`isSandboxInboundMessage`). See shared/mcp-sandbox.ts's module comment for
// the full reasoning.
//
// Theming needs no message at all: this page is served by the same Worker as
// the main app and imports the same src/style.css (see main.ts), so its own
// `prefers-color-scheme` media query already tracks the OS setting exactly like
// the rest of the SPA does.
import { Validator } from "@cfworker/json-schema";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import {
  isSandboxInboundMessage,
  type SandboxInboundMessage,
  type SandboxOutboundMessage,
} from "@shared/mcp-sandbox.ts";

import JsonEditor from "../components/JsonEditor.vue";
import JsonViewer from "../components/JsonViewer.vue";
import { placeholderFor } from "../lib/mcp-schema.ts";

import type { JsonSchema } from "../lib/json-schema-completion.ts";

// Not lazy-loaded here, unlike the main app's use of these components: this
// whole page exists only to host CodeMirror (JsonEditor above already pulls in
// the bulk of it -- state, view, language, commands, search, JSON), so
// splitting JsonViewer out from it would just be a second network round trip
// for no bundle this page will ever run without.

type Outcome =
  | { kind: "pending" }
  | { kind: "ok"; isError: boolean; data: unknown; durationMs: number }
  | { kind: "error"; message: string; issues?: string[] };

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const tool = ref<Tool | null>(null);
const argsText = ref("{}");
const parseError = ref<string | null>(null);
const schemaIssues = ref<string[]>([]);
const busy = ref(false);
const attempt = ref<{ name: string; arguments: Record<string, unknown>; outcome: Outcome } | null>(
  null,
);
const showSchema = ref(false);
const insertChoice = ref("");

// Sizes the parent's <iframe> to this page's own content (McpToolTester.vue):
// fixed at 720px before, the frame either wasted space below a short answer or
// clipped a long one behind its own scrollbar. `rootEl` is this component's
// own root -- not `document.documentElement`, whose `min-height: 100%`
// (src/style.css, shared with the main app's shell) pins it to at least the
// iframe's *current* height, which would make a reported height that reads
// off it only ever grow, never shrink back down as the frame did.
const rootEl = ref<HTMLDivElement | null>(null);
// The completion popup (CodeMirror's own tooltip) is appended outside this
// component's DOM subtree and positioned absolutely, so it does not change
// `rootEl`'s own box and a `ResizeObserver` on `rootEl` never sees it open or
// close on its own. `.completion-reserve` (the template), an ordinary in-flow
// element sized by this flag, is what makes that visible to the observer.
// ~10em of options (the popup's own max-height, jsonSchemaCompletionTheme)
// plus its border, comfortably covered by round numbers.
const COMPLETION_RESERVE_PX = 180;
const completionOpen = ref(false);
// A property on an object, not a bare top-level `let` (see JsonEditor.vue's
// `flags` for the same pattern): mutated from inside `onMounted`/
// `onBeforeUnmount` below, which a top-level variable cannot be.
const resize = { observer: null as ResizeObserver | null };
// Whichever of the three outcome-kind blocks in the template is currently
// rendered (pending/ok/error) binds this same ref -- only one exists at a
// time -- so it always names "the result the owner just ran", for scrolling
// it into view once it lands (see the `watch` below).
const resultEl = ref<HTMLElement | null>(null);

// A couple of CSS pixels of slack: `getBoundingClientRect().height` is a
// sub-pixel float, and at a fractional device pixel ratio the browser's own
// layout can round the *true* rendered height up by a pixel or two more than
// a naive `Math.ceil` of that float does. Under-reporting by even one real
// pixel gives the iframe its own pointless internal scrollbar -- every pixel
// of content visible, nothing to actually scroll to, but a scrollbar there
// regardless, which reads as "no result" to anyone who does not think to
// scroll a few px inside what looks like a fully-sized box.
const HEIGHT_SLACK_PX = 4;

function notifyParent(message: SandboxOutboundMessage): void {
  // "*", not the parent's real origin: this page is loaded with no
  // `allow-same-origin`, so it has no reliable way to name that origin either
  // (`document.referrer` and `location.ancestorOrigins` are both untrustworthy
  // or unavailable under sandboxing). The parent verifies the sender by
  // `event.source` identity instead -- see McpToolTester.vue's `isFromOurFrame`.
  // eslint-disable-next-line sonarjs/post-message -- see above; there is no origin string this opaque-origin page could address its parent by.
  window.parent.postMessage(message, "*");
}

function reportHeight(): void {
  const el = rootEl.value;
  if (el === null) return;
  // `scrollHeight` (an integer the layout engine has already rounded, not a
  // sub-pixel float) plus `HEIGHT_SLACK_PX`, rather than
  // `getBoundingClientRect().height` on its own -- see that constant's own
  // comment for why. `.sandbox` has no overflow of its own (grid children are
  // all in-flow), so `scrollHeight` here is exactly the content height, not a
  // scrolled-past-the-box measurement.
  notifyParent({ type: "resize", height: el.scrollHeight + HEIGHT_SLACK_PX });
}

onMounted(() => {
  if (typeof ResizeObserver === "undefined" || rootEl.value === null) return;
  // A `ResizeObserver` callback fires on `rootEl`'s own box changing, which
  // covers everything in its normal flow -- the tool description, the editor
  // growing with its content, a validation error, the result viewer -- plus
  // `completionReserve` toggling below, all without a separate listener per
  // cause.
  resize.observer = new ResizeObserver(reportHeight);
  resize.observer.observe(rootEl.value);
});

onBeforeUnmount(() => {
  resize.observer?.disconnect();
  resize.observer = null;
});

// Belt and braces on top of the `ResizeObserver` above: a result or error
// landing is the one moment the owner is actively waiting to see something,
// so this reports (and scrolls to) it on its own timeline rather than
// trusting the observer's own scheduling alone. `nextTick` waits for Vue to
// have actually patched the DOM with the new outcome; the `requestAnimationFrame`
// after it catches anything that only settles after that paint -- a web font
// swap, or CodeMirror's own async measurement in the editor above the result.
watch(
  () => attempt.value?.outcome.kind,
  async (kind) => {
    if (kind !== "ok" && kind !== "error") return;
    await nextTick();
    reportHeight();
    requestAnimationFrame(() => {
      reportHeight();
      resultEl.value?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  },
);

const valid = computed(
  () => tool.value !== null && parseError.value === null && schemaIssues.value.length === 0,
);

function schemaProperties(schema: Record<string, unknown>): Record<string, JsonSchema> {
  const properties = schema.properties;
  return typeof properties === "object" && properties !== null
    ? (properties as Record<string, JsonSchema>)
    : {};
}

function schemaRequired(schema: Record<string, unknown>): Set<string> {
  const required = schema.required;
  return new Set(
    Array.isArray(required) ? required.filter((entry) => typeof entry === "string") : [],
  );
}

/** Whatever the current arguments text parses to, or `{}` if it does not parse -- never thrown. */
function parsedArgsOrEmpty(): Record<string, unknown> {
  try {
    const candidate: unknown = JSON.parse(argsText.value);
    return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The tool's properties not already present in the arguments, required ones
 * first, for the "insert a field" dropdown below the editor.
 */
const insertableProperties = computed<{ key: string; required: boolean }[]>(() => {
  if (tool.value === null) return [];
  const properties = schemaProperties(tool.value.inputSchema);
  const required = schemaRequired(tool.value.inputSchema);
  const existing = new Set(Object.keys(parsedArgsOrEmpty()));
  return Object.keys(properties)
    .filter((key) => !existing.has(key))
    .toSorted((a, b) => Number(required.has(b)) - Number(required.has(a)) || a.localeCompare(b))
    .map((key) => ({ key, required: required.has(key) }));
});

/**
 * Inserts one property, pre-filled with a placeholder value for its type, and
 * re-renders the whole document from the parsed result. That loses the
 * cursor position and the undo step a targeted insert into the view would
 * have kept -- acceptable here, since this is a one-off "give me a starting
 * point" action, not something done mid-edit.
 */
function insertField(key: string): void {
  if (tool.value === null) return;
  const properties = schemaProperties(tool.value.inputSchema);
  const propertySchema = Object.hasOwn(properties, key) ? properties[key] : undefined;
  const parsed = parsedArgsOrEmpty();
  parsed[key] = propertySchema === undefined ? null : placeholderFor(propertySchema);
  onArgsChanged(JSON.stringify(parsed, null, 2));
}

function onInsertChoice(): void {
  const key = insertChoice.value;
  insertChoice.value = "";
  if (key !== "") insertField(key);
}

function validate(): void {
  parseError.value = null;
  schemaIssues.value = [];
  if (tool.value === null) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(argsText.value);
  } catch (error) {
    parseError.value = error instanceof Error ? error.message : "invalid JSON";
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    parseError.value = "must be a JSON object";
    return;
  }

  const validator = new Validator(tool.value.inputSchema, "7", false);
  const result = validator.validate(parsed);
  if (!result.valid) {
    schemaIssues.value = result.errors.map(
      (issue) => `${issue.instanceLocation || "/"} ${issue.error}`,
    );
  }
}

function onArgsChanged(text: string): void {
  argsText.value = text;
  validate();
}

function onCompletionOpen(open: boolean): void {
  completionOpen.value = open;
}

function run(): void {
  if (!valid.value || tool.value === null || busy.value) return;
  const args = JSON.parse(argsText.value) as Record<string, unknown>;
  busy.value = true;
  attempt.value = { name: tool.value.name, arguments: args, outcome: { kind: "pending" } };
  notifyParent({ type: "run", name: tool.value.name, arguments: args });
}

function onMessage(message: SandboxInboundMessage): void {
  switch (message.type) {
    case "tool": {
      tool.value = {
        name: message.name,
        description: message.description,
        inputSchema: message.inputSchema,
      };
      argsText.value = JSON.stringify(message.skeleton, null, 2);
      attempt.value = null;
      busy.value = false;
      validate();
      break;
    }
    case "result": {
      if (attempt.value === null) break;
      attempt.value = {
        ...attempt.value,
        outcome: {
          kind: "ok",
          isError: message.isError,
          data: message.data,
          durationMs: message.durationMs,
        },
      };
      busy.value = false;
      break;
    }
    case "call-error": {
      if (attempt.value === null) break;
      attempt.value = {
        ...attempt.value,
        outcome: {
          kind: "error",
          message: message.message,
          ...(message.issues && { issues: message.issues }),
        },
      };
      busy.value = false;
      break;
    }
  }
}

// Verified by identity (`event.source === window.parent`), not by
// `event.origin`: this page is loaded with no `allow-same-origin`, so its own
// origin is opaque and `event.origin` on every message it receives is the
// literal string "null" regardless of who actually sent it.
// eslint-disable-next-line sonarjs/post-message -- see above; origin comparison is not possible for an opaque-origin page, so identity on event.source is the verification.
window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window.parent || !isSandboxInboundMessage(event.data)) return;
  onMessage(event.data);
});

notifyParent({ type: "ready" });
</script>

<template>
  <div ref="rootEl" class="sandbox">
    <template v-if="tool === null">
      <p class="muted">Waiting for a tool…</p>
    </template>
    <template v-else>
      <p class="muted">{{ tool.description }}</p>

      <div class="row">
        <div class="field-label">Arguments (JSON)</div>
        <span class="spacer"></span>
        <select
          v-model="insertChoice"
          :disabled="insertableProperties.length === 0"
          @change="onInsertChoice"
        >
          <option value="">Insert field…</option>
          <option
            v-for="property in insertableProperties"
            :key="property.key"
            :value="property.key"
          >
            {{ property.key }}{{ property.required ? " (required)" : "" }}
          </option>
        </select>
        <button type="button" class="small" @click="showSchema = !showSchema">
          {{ showSchema ? "Hide schema" : "Show schema" }}
        </button>
      </div>
      <div v-if="showSchema" class="viewer-block">
        <JsonViewer :value="tool.inputSchema" />
      </div>
      <JsonEditor
        :model-value="argsText"
        :schema="tool.inputSchema"
        @update:model-value="onArgsChanged"
        @run="run"
        @completion-open="onCompletionOpen"
      />
      <p v-if="parseError" class="warn-text">{{ parseError }}</p>
      <ul v-else-if="schemaIssues.length > 0" class="warn-text issues">
        <li v-for="issue in schemaIssues" :key="issue">{{ issue }}</li>
      </ul>

      <div class="row">
        <button class="primary" type="button" :disabled="!valid || busy" @click="run">
          {{ busy ? "Running…" : "Run" }}
        </button>
        <span class="muted">Ctrl/Cmd+Enter runs</span>
      </div>

      <template v-if="attempt">
        <div class="viewer-block">
          <h3>Request</h3>
          <JsonViewer :value="{ name: attempt.name, arguments: attempt.arguments }" />
        </div>

        <div v-if="attempt.outcome.kind === 'pending'" class="viewer-block">
          <p class="muted">Running…</p>
        </div>
        <div v-else-if="attempt.outcome.kind === 'ok'" ref="resultEl" class="viewer-block">
          <div class="row">
            <h3>Result</h3>
            <span :class="attempt.outcome.isError ? 'danger-text' : ''">
              {{ attempt.outcome.isError ? "error" : "ok" }}
            </span>
            <span class="muted">{{ attempt.outcome.durationMs }} ms</span>
          </div>
          <JsonViewer :value="attempt.outcome.data" />
        </div>
        <div v-else-if="attempt.outcome.kind === 'error'" ref="resultEl" class="viewer-block">
          <h3>Result</h3>
          <p class="warn-text">{{ attempt.outcome.message }}</p>
          <ul v-if="attempt.outcome.issues" class="warn-text issues">
            <li v-for="issue in attempt.outcome.issues" :key="issue">{{ issue }}</li>
          </ul>
        </div>
      </template>

      <!-- An in-flow placeholder, not a comment on the popup itself: it exists
           so the ResizeObserver above (which only sees rootEl's own box) also
           accounts for the completion popup, which renders outside this
           subtree and would not otherwise change that box at all. Kept last,
           after everything the popup could actually be open over, so growing
           it never shifts the editor, Run or a result already on screen --
           the iframe's bottom edge moves into blank space instead. -->
      <div
        v-if="completionOpen"
        class="completion-reserve"
        :style="{ height: `${COMPLETION_RESERVE_PX}px` }"
      />
    </template>
  </div>
</template>

<style scoped>
.sandbox {
  display: grid;
  gap: 10px;
  padding: 12px;
  min-width: 0;
}

h3 {
  font-size: 0.95rem;
  margin: 0;
}

.field-label {
  font-size: 0.88rem;
  color: var(--text-dim);
}

.issues {
  margin: 0;
  padding-left: 20px;
  display: grid;
  gap: 2px;
}

.viewer-block {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.warn-text {
  color: var(--warn);
  font-size: 0.88rem;
}

.muted {
  color: var(--text-dim);
  font-size: 0.88rem;
  margin: 0;
}
</style>
