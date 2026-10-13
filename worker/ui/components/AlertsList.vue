<script setup lang="ts">
// Open (and, on /alerts, recently resolved) alerts: a connection to sign in to
// again, a sync that keeps failing, or a phone whose uploads were set aside.
//
// An alert's subject is `health_system:<id>`, `portal:<id>`, `google` or `sync`
// (a run that stops before reaching any of them), so the list needs the health
// system names to say anything useful; it takes a lookup rather than fetching
// them itself.

import { formatDateTime, humanizeCode, relativeTime } from "../lib/format.ts";

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
  // The subject of a phone's alert is this app's own device id, which says
  // nothing to the owner; the Phone page names the phone.
  if (alert.kind === "hc_parked") return "Phone uploads";
  if (alert.healthSystemId === null) {
    if (alert.subject === "google") return "Google Calendar";
    return alert.subject === "sync" ? "Scheduled sync" : alert.subject;
  }
  const name = Object.hasOwn(props.healthSystemNames, alert.healthSystemId)
    ? (props.healthSystemNames[alert.healthSystemId] ?? alert.healthSystemId)
    : alert.healthSystemId;
  // A portal and a FHIR connection are two alerts about one health system,
  // fixed in different places: say which this is.
  return alert.subject.startsWith("portal:") ? `${name} patient portal` : name;
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
        <template v-if="alert.kind === 'hc_parked'">
          could not be applied and are being kept ·
          <RouterLink to="/phone">see the Phone page</RouterLink> ·
        </template>
        <template v-else-if="alert.kind === 'sync_failing'">
          sync keeps failing<template v-if="alert.reasonCode">
            ({{ humanizeCode(alert.reasonCode) }})</template
          >
          · nothing to reconnect, it is retried every hour ·
        </template>
        <template v-else>
          needs re-auth<template v-if="alert.reasonCode">
            ({{ humanizeCode(alert.reasonCode) }})</template
          >
          ·
        </template>
        opened {{ relativeTime(alert.openedAt) }}
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
