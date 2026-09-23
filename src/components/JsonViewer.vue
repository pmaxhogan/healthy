<script setup lang="ts">
// A read-only, foldable, searchable JSON viewer -- CodeMirror 6 underneath, not a
// Monaco port. Used inside the sandboxed "Try a tool" page
// (src/sandbox/SandboxApp.vue) for both the exact request JSON sent and the
// tool's result, so the two ever look and behave identically. See
// src/lib/codemirror-json.ts for the shared theme and extensions, and
// shared/mcp-sandbox.ts for why this lives in a sandboxed page at all.
//
// Deliberately has no dependency on this app's global toast queue (or anything
// else app-global): the sandboxed page that hosts it has no `ToastStack` to
// render one, so "copied" is a local flash on the button itself instead.
import { foldAll, foldKeymap, unfoldAll } from "@codemirror/language";
import { openSearchPanel, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";

import { jsonBaseExtensions } from "../lib/codemirror-json.ts";
import { formatBytes } from "../lib/format.ts";

const props = defineProps<{ value: unknown }>();

const hostEl = ref<HTMLDivElement | null>(null);
const byteSize = ref(0);
const copied = ref(false);
// A ref, not a bare module-level `let`: the editor instance is written from
// several handlers below (mount, unmount, prop updates), and a ref's `.value` is
// how that stays a property write on an object rather than a reassignment of a
// shared variable.
const editor = shallowRef<EditorView | null>(null);

/**
 * Pretty-printed JSON text for the current `value`.
 *
 * `JSON.stringify` can throw (a BigInt, a circular structure) even though
 * `value` is whatever a tool call answered with -- always JSON off the wire, but
 * typed `unknown` here because this component has no reason to trust that. The
 * fallback is a fixed sentence rather than `String(value)`: an arbitrary
 * `unknown` stringifies to `"[object Object]"` far more often than to anything
 * useful.
 */
function textOf(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "(could not be serialised as JSON)";
  }
}

function extensions() {
  return [
    ...jsonBaseExtensions(),
    EditorView.editable.of(false),
    EditorState.readOnly.of(true),
    keymap.of([...foldKeymap, ...searchKeymap]),
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
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    // Clipboard access can be denied by the browser, or (inside the sandboxed
    // iframe this component normally runs in) by the platform. There is no
    // toast host here to report that separately from success, and the button
    // simply not flashing "Copied" says enough.
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
      <button type="button" class="small spacer" @click="copy">
        {{ copied ? "Copied" : "Copy" }}
      </button>
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
