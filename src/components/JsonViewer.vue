<script setup lang="ts">
// A read-only, foldable, searchable JSON viewer -- CodeMirror 6 underneath, not a
// Monaco port. Used twice on the MCP page's "Try a tool" panel: once for the
// exact request JSON sent, once for the tool's result. Both are the same
// component so the two ever look and behave identically.
//
// Dynamically imported by whatever renders it (see McpToolTester.vue): this file
// is a normal, statically-imported module graph, and it is the *import()* at the
// call site that gives it its own chunk. CodeMirror plus its JSON language and
// search packages are not small, and nothing on the rest of the MCP page needs
// them.
//
// Every colour comes from this app's own CSS custom properties (src/style.css),
// passed straight into CodeMirror's theme and highlight-style builders as CSS
// strings. CodeMirror re-injects its stylesheet through the CSSOM, so a value
// like `var(--accent)` is resolved by the browser at paint time -- the same
// light/dark switch the rest of the SPA gets from `prefers-color-scheme`, with no
// extra JavaScript here to keep in sync with it.
import { json } from "@codemirror/lang-json";
import {
  HighlightStyle,
  foldAll,
  foldGutter,
  foldKeymap,
  syntaxHighlighting,
  unfoldAll,
} from "@codemirror/language";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";

import { formatBytes } from "../lib/format.ts";
import { toastError, toastSuccess } from "../lib/toasts.ts";

const props = defineProps<{ value: unknown }>();

const hostEl = ref<HTMLDivElement | null>(null);
const byteSize = ref(0);
// A ref, not a bare module-level `let`: the editor instance is written from
// several handlers below (mount, unmount, prop updates), and a ref's `.value` is
// how that stays a property write on an object rather than a reassignment of a
// shared variable.
const editor = shallowRef<EditorView | null>(null);

/**
 * Pretty-printed JSON text for the current `value`.
 *
 * `JSON.stringify` can throw (a BigInt, a circular structure) even though `value`
 * is whatever a tool call answered with -- always JSON off the wire, but typed
 * `unknown` here because this component has no reason to trust that. The fallback
 * is a fixed sentence rather than `String(value)`: an arbitrary `unknown` stringifies
 * to `"[object Object]"` far more often than to anything useful.
 */
function textOf(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "(could not be serialised as JSON)";
  }
}

const highlight = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--accent)" },
  { tag: tags.string, color: "var(--ok)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--warn)" },
  {
    tag: [tags.punctuation, tags.separator, tags.squareBracket, tags.brace],
    color: "var(--text-dim)",
  },
]);

// CodeMirror's built-in styles for these elements are hard-coded to light-mode
// colours (a white search panel, grey gutters), which this app's dark theme would
// otherwise show through untouched. Everything the base theme colours is
// overridden here, by CSS var, so both themes stay in sync automatically.
const theme = EditorView.theme({
  "&": {
    color: "var(--text)",
    backgroundColor: "var(--bg-input)",
    borderRadius: "8px",
    border: "1px solid var(--border)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-content": {
    fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
    fontSize: "0.85rem",
    caretColor: "var(--text)",
  },
  ".cm-scroller": { maxHeight: "420px", overflow: "auto" },
  ".cm-gutters": {
    backgroundColor: "var(--bg-input)",
    color: "var(--text-dim)",
    border: "none",
  },
  ".cm-foldGutter": { width: "1.1em" },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--bg-raised)",
    borderColor: "var(--border)",
    color: "var(--text-dim)",
    borderRadius: "4px",
    padding: "0 4px",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 35%, transparent) !important",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in srgb, var(--warn) 30%, transparent)",
    outline: "1px solid color-mix(in srgb, var(--warn) 60%, transparent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--warn) 55%, transparent)",
  },
  ".cm-panels": { backgroundColor: "var(--bg-raised)", color: "var(--text)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panel.cm-search": { display: "flex", flexWrap: "wrap", gap: "6px", padding: "6px" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label": {
    color: "var(--text)",
    backgroundColor: "var(--bg-input)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--bg-raised)",
    color: "var(--text)",
    border: "1px solid var(--border)",
  },
});

function extensions() {
  return [
    lineNumbers(),
    foldGutter(),
    EditorView.editable.of(false),
    EditorState.readOnly.of(true),
    EditorView.lineWrapping,
    json(),
    syntaxHighlighting(highlight, { fallback: true }),
    search({ top: true }),
    keymap.of([...foldKeymap, ...searchKeymap]),
    theme,
  ];
}

function setText(text: string): void {
  byteSize.value = new TextEncoder().encode(text).length;
  const view = editor.value;
  if (view === null) return;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}

onMounted(() => {
  if (hostEl.value === null) return;
  const text = textOf(props.value);
  byteSize.value = new TextEncoder().encode(text).length;
  editor.value = new EditorView({
    state: EditorState.create({ doc: text, extensions: extensions() }),
    parent: hostEl.value,
  });
});

onBeforeUnmount(() => {
  editor.value?.destroy();
  editor.value = null;
});

watch(
  () => props.value,
  (value) => {
    setText(textOf(value));
  },
);

function expandAll(): void {
  if (editor.value) unfoldAll(editor.value);
}

function collapseAll(): void {
  if (editor.value) foldAll(editor.value);
}

function openSearch(): void {
  if (editor.value) openSearchPanel(editor.value);
}

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(textOf(props.value));
    toastSuccess("Copied to clipboard.");
  } catch {
    toastError("Could not copy -- clipboard access was denied.");
  }
}

defineExpose({ expandAll, collapseAll, openSearch, copy });
</script>

<template>
  <div class="json-viewer">
    <div class="toolbar">
      <button type="button" class="small" @click="expandAll">Expand all</button>
      <button type="button" class="small" @click="collapseAll">Collapse all</button>
      <button type="button" class="small" @click="openSearch">Search</button>
      <button type="button" class="small spacer" @click="copy">Copy</button>
      <span class="muted size">{{ formatBytes(byteSize) }}</span>
    </div>
    <div ref="hostEl" class="editor-host" />
  </div>
</template>

<style scoped>
.json-viewer {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.size {
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
}

.editor-host {
  min-width: 0;
}

.editor-host :deep(.cm-editor) {
  height: 100%;
}
</style>
