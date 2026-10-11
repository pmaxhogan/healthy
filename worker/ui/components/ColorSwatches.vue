<script setup lang="ts">
// The Google event colour picker. Swatches come from GET /api/google/colors --
// the live palette -- because the ids are only meaningful against whatever
// Google currently serves, and a hard-coded list goes stale silently.
//
// The colours are applied with `:style`, which Vue writes through CSSOM. That is
// deliberate: the CSP has no `unsafe-inline` for styles, so a literal
// `style="..."` attribute in a template would be blocked.

import type { ColorOptionDto } from "@shared/types.ts";

const props = withDefaults(
  defineProps<{
    colors: ColorOptionDto[];
    modelValue: string | null;
    /** Offered as the first choice, for "inherit the default". */
    allowDefault?: boolean;
    defaultLabel?: string;
    disabled?: boolean;
  }>(),
  { allowDefault: true, defaultLabel: "Default", disabled: false },
);

const emit = defineEmits<{ "update:modelValue": [value: string | null] }>();

function pick(id: string | null): void {
  if (!props.disabled) emit("update:modelValue", id);
}
</script>

<template>
  <div class="swatches" role="radiogroup">
    <button
      v-if="allowDefault"
      type="button"
      class="swatch none"
      role="radio"
      :aria-checked="modelValue === null"
      :class="{ picked: modelValue === null }"
      :disabled="disabled"
      :title="defaultLabel"
      @click="pick(null)"
    >
      <span class="none-mark" aria-hidden="true">/</span>
      <span class="sr">{{ defaultLabel }}</span>
    </button>

    <button
      v-for="color in colors"
      :key="color.id"
      type="button"
      class="swatch"
      role="radio"
      :aria-checked="modelValue === color.id"
      :class="{ picked: modelValue === color.id }"
      :style="{ background: color.background }"
      :disabled="disabled"
      :title="`Colour ${color.id}`"
      @click="pick(color.id)"
    >
      <span class="sr">Colour {{ color.id }}</span>
    </button>
  </div>
</template>

<style scoped>
.swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.swatch {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  padding: 0;
  border: 2px solid transparent;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 12%);
}

.swatch.picked {
  border-color: var(--text);
}

.swatch.none {
  background: var(--bg-input);
  color: var(--text-dim);
  display: grid;
  place-items: center;
}

.none-mark {
  font-size: 0.95rem;
  line-height: 1;
}

.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
