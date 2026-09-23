<script setup lang="ts">
import { dismissToast, toasts } from "../lib/toasts.ts";
</script>

<template>
  <div class="stack" aria-live="polite" aria-atomic="false">
    <div v-for="toast in toasts" :key="toast.id" class="toast" :class="toast.tone">
      <span class="text">{{ toast.text }}</span>
      <button v-if="toast.action" class="small" @click="toast.action.run()">
        {{ toast.action.label }}
      </button>
      <button class="close" aria-label="Dismiss" @click="dismissToast(toast.id)">&times;</button>
    </div>
  </div>
</template>

<style scoped>
.stack {
  position: fixed;
  /* Above the bottom edge on a phone, clear of the home indicator. */
  bottom: calc(12px + env(safe-area-inset-bottom));
  left: 16px;
  right: 16px;
  display: grid;
  gap: 8px;
  justify-items: stretch;
  z-index: 20;
  pointer-events: none;
}

@media (min-width: 640px) {
  .stack {
    left: auto;
    max-width: 380px;
    right: 24px;
    bottom: 24px;
  }
}

.toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-left: 3px solid var(--text-dim);
  border-radius: 10px;
  padding: 10px 12px;
  box-shadow: var(--shadow);
  font-size: 0.9rem;
}

.toast.success {
  border-left-color: var(--ok);
}

.toast.error {
  border-left-color: var(--danger);
}

.toast.info {
  border-left-color: var(--accent);
}

.text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.close {
  background: none;
  padding: 0 2px;
  color: var(--text-dim);
  font-size: 1.1rem;
  line-height: 1;
}
</style>
