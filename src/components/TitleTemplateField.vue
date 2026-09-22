<script setup lang="ts">
// A title template with its placeholder palette and a live preview.
//
// The preview is rendered in the browser from a synthetic appointment, so typing
// costs nothing and the owner can see what a template does before a sync proves
// it. src/lib/template.ts says what it does and does not promise.

import { computed, ref } from "vue";

import { PLACEHOLDERS, previewTitle, SAMPLE_VIEW } from "../lib/template.ts";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    label?: string;
    placeholder?: string;
  }>(),
  { label: "Title template", placeholder: "" },
);

const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const input = ref<HTMLInputElement | null>(null);
const preview = computed(() => previewTitle(props.modelValue));

/** Appends a placeholder at the caret, which is where a click means to put it. */
function insert(name: string): void {
  const element = input.value;
  const token = `{${name}}`;
  if (!element) {
    emit("update:modelValue", props.modelValue + token);
    return;
  }
  const start = element.selectionStart ?? props.modelValue.length;
  const end = element.selectionEnd ?? start;
  const next = props.modelValue.slice(0, start) + token + props.modelValue.slice(end);
  emit("update:modelValue", next);
  // Put the caret after what was just inserted, on the next tick's value.
  requestAnimationFrame(() => {
    element.focus();
    element.setSelectionRange(start + token.length, start + token.length);
  });
}
</script>

<template>
  <div class="wrap">
    <label class="field">
      {{ label }}
      <input
        ref="input"
        :value="modelValue"
        :placeholder="placeholder"
        spellcheck="false"
        autocomplete="off"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      />
    </label>

    <div class="chips">
      <button
        v-for="name in PLACEHOLDERS"
        :key="name"
        type="button"
        class="chip insert"
        :title="`Insert {${name}} — sample: ${SAMPLE_VIEW[name]}`"
        @click="insert(name)"
      >
        {{ name }}
      </button>
    </div>

    <p class="preview">
      <span class="tag">Preview</span>
      <span v-if="preview.text">{{ preview.text }}</span>
      <span v-else class="muted">empty</span>
    </p>

    <p v-if="preview.unknown.length > 0" class="muted danger-text">
      Unknown placeholder{{ preview.unknown.length > 1 ? "s" : "" }}:
      {{ preview.unknown.join(", ") }}
    </p>
  </div>
</template>

<style scoped>
.wrap {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.chip.insert {
  cursor: pointer;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.chip.insert:hover {
  color: var(--text);
  border-color: var(--accent);
}

.preview {
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 0.92rem;
  overflow-wrap: anywhere;
}

.tag {
  flex: none;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
}
</style>
