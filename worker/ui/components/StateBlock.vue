<script setup lang="ts">
// The loading / error / empty triad. A panel wraps its content in one of these
// and stops thinking about the three cases separately.
//
// `ready` is the slot's guard: the default slot renders only when there is
// something to render, so a template can dereference the loaded value without a
// null check on every line.

withDefaults(
  defineProps<{
    loading: boolean;
    error?: string | null;
    /** True when the load succeeded but there is nothing to show. */
    empty?: boolean;
    emptyText?: string;
    loadingText?: string;
  }>(),
  {
    error: null,
    empty: false,
    emptyText: "Nothing here yet.",
    loadingText: "Loading…",
  },
);

defineEmits<{ retry: [] }>();
</script>

<template>
  <p v-if="loading" class="state muted" aria-live="polite">
    <span class="spinner" aria-hidden="true" />
    {{ loadingText }}
  </p>

  <div v-else-if="error" class="state" role="alert">
    <p class="danger-text">{{ error }}</p>
    <button class="small" @click="$emit('retry')">Try again</button>
  </div>

  <p v-else-if="empty" class="state muted">{{ emptyText }}</p>

  <slot v-else />
</template>

<style scoped>
.state {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
}

.spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex: none;
}

@keyframes spin {
  to {
    transform: rotate(1turn);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation-duration: 2.4s;
  }
}
</style>
