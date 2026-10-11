<script setup lang="ts">
import { computed } from "vue";

import type { ConnectionStatus } from "@shared/types.ts";

/**
 * The one place a connection status becomes a colour and a word. `not_connected`
 * is the Google account's extra state; everything else is a `ConnectionStatus`.
 */
type PillStatus = ConnectionStatus | "not_connected";

const LABELS: Record<PillStatus, string> = {
  connected: "connected",
  needs_reauth: "needs re-auth",
  error: "error",
  disconnected: "disconnected",
  not_connected: "not connected",
};

const TONES: Record<PillStatus, string> = {
  connected: "ok",
  needs_reauth: "warn",
  error: "danger",
  disconnected: "dim",
  not_connected: "dim",
};

const props = defineProps<{ status: PillStatus }>();

const label = computed(() => LABELS[props.status]);
const tone = computed(() => TONES[props.status]);
</script>

<template>
  <span class="pill" :class="tone">{{ label }}</span>
</template>

<style scoped>
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid;
  border-radius: 999px;
  padding: 1px 9px;
  font-size: 0.78rem;
  font-weight: 600;
  white-space: nowrap;
}

.pill::before {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentcolor;
}

.ok {
  color: var(--ok);
  border-color: color-mix(in srgb, var(--ok) 40%, transparent);
  background: color-mix(in srgb, var(--ok) 12%, transparent);
}

.warn {
  color: var(--warn);
  border-color: color-mix(in srgb, var(--warn) 40%, transparent);
  background: color-mix(in srgb, var(--warn) 12%, transparent);
}

.danger {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 40%, transparent);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}

.dim {
  color: var(--text-dim);
  border-color: var(--border);
  background: var(--bg-input);
}
</style>
