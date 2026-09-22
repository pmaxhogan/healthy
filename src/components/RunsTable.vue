<script setup lang="ts">
// The run log, shared by the overview (compact) and /runs (expandable).
//
// A summary is counts only -- that is what the Worker writes -- so showing the
// raw JSON is safe and is the fastest way to read a sync that went sideways.

import { ref } from "vue";

import { formatDateTime, formatDuration, relativeTime } from "../lib/format.ts";

import type { RunDto } from "@shared/types.ts";

const props = withDefaults(
  defineProps<{
    runs: RunDto[];
    timezone: string | null;
    /** /runs shows the summary JSON; the overview card does not. */
    expandable?: boolean;
  }>(),
  { expandable: false },
);

const open = ref<string | null>(null);

function toggle(id: string): void {
  open.value = open.value === id ? null : id;
}

function outcome(run: RunDto): string {
  if (run.ok === null) return "running";
  return run.ok ? "ok" : "failed";
}

function elapsed(run: RunDto): string {
  if (!run.finishedAt) return "—";
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? formatDuration(ms) : "—";
}

/** The counts worth a column, in reading order. */
function counts(run: RunDto): string {
  const s = run.summary;
  if (!s) return "—";
  const parts = [
    s.eventsInserted > 0 ? `+${String(s.eventsInserted)}` : "",
    s.eventsPatched > 0 ? `~${String(s.eventsPatched)}` : "",
    s.eventsGhosted > 0 ? `†${String(s.eventsGhosted)}` : "",
    s.eventsRestored > 0 ? `↺${String(s.eventsRestored)}` : "",
    s.resourcesCached > 0 ? `${String(s.resourcesCached)} cached` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "no changes";
}
</script>

<template>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Kind</th>
          <th>When</th>
          <th>Took</th>
          <th>Result</th>
          <th>Counts</th>
          <th v-if="props.expandable" class="nowrap">Summary</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="run in runs" :key="run.id">
          <tr>
            <td class="nowrap">{{ run.kind }}</td>
            <td class="nowrap" :title="formatDateTime(run.startedAt, timezone)">
              {{ relativeTime(run.startedAt) }}
            </td>
            <td class="nowrap">{{ elapsed(run) }}</td>
            <td class="nowrap" :class="{ 'danger-text': run.ok === false }">{{ outcome(run) }}</td>
            <td>{{ counts(run) }}</td>
            <td v-if="props.expandable">
              <button
                class="small"
                :aria-expanded="open === run.id"
                :disabled="!run.summary"
                @click="toggle(run.id)"
              >
                {{ open === run.id ? "Hide" : "Show" }}
              </button>
            </td>
          </tr>
          <tr v-if="props.expandable && open === run.id && run.summary">
            <td colspan="6">
              <pre>{{ JSON.stringify(run.summary, null, 2) }}</pre>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>
