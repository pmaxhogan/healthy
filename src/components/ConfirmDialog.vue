<script setup lang="ts">
// A custom modal rather than window.confirm: the native dialog cannot say what
// exactly is about to be removed, and on a phone it is indistinguishable from a
// browser warning.

import { onMounted, ref } from "vue";

const props = withDefaults(
  defineProps<{
    title: string;
    body?: string;
    confirmLabel?: string;
    /** Requires the owner to type this word before confirming. */
    requireText?: string | null;
    busy?: boolean;
  }>(),
  { body: "", confirmLabel: "Remove", requireText: null, busy: false },
);

const emit = defineEmits<{ confirm: []; cancel: [] }>();

const typed = ref("");
const confirmButton = ref<HTMLButtonElement | null>(null);
const textInput = ref<HTMLInputElement | null>(null);

onMounted(() => {
  // Focus lands inside the dialog so Escape and Enter do the obvious thing and
  // a keyboard user is not left behind the backdrop.
  (props.requireText === null ? confirmButton.value : textInput.value)?.focus();
});

function satisfied(): boolean {
  return props.requireText === null || typed.value.trim() === props.requireText;
}
</script>

<template>
  <div
    class="backdrop"
    role="dialog"
    aria-modal="true"
    :aria-label="title"
    @click.self="emit('cancel')"
    @keydown.esc="emit('cancel')"
  >
    <div class="dialog">
      <h2>{{ title }}</h2>
      <p v-if="body" class="muted">{{ body }}</p>

      <label v-if="requireText !== null" class="field">
        Type <code>{{ requireText }}</code> to confirm
        <input
          ref="textInput"
          v-model="typed"
          autocomplete="off"
          @keydown.enter="emit('confirm')"
        />
      </label>

      <div class="row">
        <button :disabled="busy" @click="emit('cancel')">Cancel</button>
        <button
          ref="confirmButton"
          class="confirm spacer"
          :disabled="busy || !satisfied()"
          @click="emit('confirm')"
        >
          {{ busy ? "Working…" : confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 45%);
  display: grid;
  place-items: center;
  padding: 16px;
  z-index: 30;
}

.dialog {
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 18px;
  width: 100%;
  max-width: 420px;
  display: grid;
  gap: 12px;
}

.dialog h2 {
  font-size: 1.05rem;
}

.confirm {
  background: var(--danger);
  color: #fff;
  font-weight: 600;
}
</style>
