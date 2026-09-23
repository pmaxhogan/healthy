<script setup lang="ts">
// The editable half of the sandboxed "Try a tool" page: a CodeMirror 6 JSON
// editor for the arguments, sharing its theme and base extensions with the
// read-only JsonViewer.vue (src/lib/codemirror-json.ts) so the two look and
// behave like one product.
//
// A controlled component: `modelValue` is the source of truth, and an edit
// from inside CodeMirror is reported back via `update:modelValue` rather than
// read out of the view on demand -- the parent (SandboxApp.vue) is what
// validates the text against the tool's schema and decides whether Run is
// enabled, and it can only react to changes it is told about.
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { foldKeymap } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";

import { jsonBaseExtensions } from "../lib/codemirror-json.ts";

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ "update:modelValue": [value: string]; run: [] }>();

const hostEl = ref<HTMLDivElement | null>(null);
const editor = shallowRef<EditorView | null>(null);
// A property on an object, not a bare top-level `let`: set around a
// programmatic `dispatch` from the `modelValue` watcher, so the update
// listener below does not echo the parent's own value straight back to it as
// if the person had typed it.
const flags = { applyingExternalValue: false };

function extensions() {
  return [
    ...jsonBaseExtensions(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, ...searchKeymap, indentWithTab]),
    // `Prec.highest` so Ctrl/Cmd+Enter reaches this binding before the default
    // keymap's own bindings get a look at it.
    Prec.highest(
      keymap.of([
        {
          key: "Mod-Enter",
          run: () => {
            emit("run");
            return true;
          },
        },
      ]),
    ),
    EditorView.updateListener.of((update) => {
      if (!flags.applyingExternalValue && update.docChanged) {
        emit("update:modelValue", update.state.doc.toString());
      }
    }),
  ];
}

onMounted(() => {
  if (hostEl.value === null) return;
  editor.value = new EditorView({
    state: EditorState.create({ doc: props.modelValue, extensions: extensions() }),
    parent: hostEl.value,
  });
});

onBeforeUnmount(() => {
  editor.value?.destroy();
  editor.value = null;
});

watch(
  () => props.modelValue,
  (value) => {
    const view = editor.value;
    if (view === null || view.state.doc.toString() === value) return;
    flags.applyingExternalValue = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    flags.applyingExternalValue = false;
  },
);
</script>

<template>
  <div ref="hostEl" class="editor-host" />
</template>

<style scoped>
.editor-host {
  min-width: 0;
}
</style>
