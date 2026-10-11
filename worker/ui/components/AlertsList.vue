<script setup lang="ts">
// Open (and, on /alerts, recently resolved) reconnect alerts.
//
// An alert's subject is `health_system:<id>` or `google`, so the list needs the
// health system names to say anything useful; it takes a lookup rather than fetching
// them itself.

import { formatDateTime, relativeTime } from "../lib/format.ts";

import type { AlertDto } from "@shared/types.ts";

const props = withDefaults(
  defineProps<{
    alerts: AlertDto[];
    timezone: string | null;
    /** healthSystemId -> display name, for subjects that name a health system. */
    healthSystemNames?: Record<string, string>;
  }>(),
  { healthSystemNames: () => ({}) },
);

function subjectLabel(alert: AlertDto): string {
  if (alert.healthSystemId === null)
    return alert.subject === "google" ? "Google Calendar" : alert.subject;
  return Object.hasOwn(props.healthSystemNames, alert.healthSystemId)
    ? (props.healthSystemNames[alert.healthSystemId] ?? alert.healthSystemId)
    : alert.healthSystemId;
}
</script>

<template>
  <ul class="alerts">
    <li v-for="alert in alerts" :key="alert.id" :class="{ resolved: alert.resolvedAt !== null }">
      <div class="head">
        <span class="subject">{{ subjectLabel(alert) }}</span>
        <span class="chip">{{ alert.resolvedAt === null ? "open" : "resolved" }}</span>
      </div>
      <p class="muted">
        needs re-auth · opened {{ relativeTime(alert.openedAt) }}
        <span :title="formatDateTime(alert.openedAt, timezone)" />
        <template v-if="alert.resolvedAt !== null">
          · resolved {{ relativeTime(alert.resolvedAt) }}
        </template>
        <template v-if="alert.trelloCardId">· card opened</template>
      </p>
    </li>
  </ul>
</template>

<style scoped>
.alerts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
}

li {
  border-left: 3px solid var(--warn);
  padding-left: 10px;
}

li.resolved {
  border-left-color: var(--border);
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.subject {
  font-weight: 600;
}
</style>
