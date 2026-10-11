<script setup lang="ts">
import { computed } from "vue";

import type { DeviceCoverageStatus, DeviceStatus } from "@shared/types.ts";

/**
 * The one place a phone's status, or one of its record types' coverage status,
 * becomes a colour and a word. The two vocabularies overlap (`stale`, `never`),
 * so one table serves both.
 */
type PillStatus = DeviceStatus | DeviceCoverageStatus;

const LABELS: Record<PillStatus, string> = {
  active: "active",
  stale: "stale",
  revoked: "revoked",
  never: "never uploaded",
  ok: "ok",
  partial: "partial",
  failed: "failed",
  unsupported: "unsupported",
};

const TONES: Record<PillStatus, string> = {
  active: "ok",
  ok: "ok",
  stale: "warn",
  partial: "warn",
  failed: "danger",
  revoked: "dim",
  never: "dim",
  unsupported: "dim",
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
