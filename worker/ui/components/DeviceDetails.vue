<script setup lang="ts">
// One phone's per-record-type coverage and its recent uploads.
//
// Mounted only when the owner opens a device's details, so the page does not
// fetch two tables per phone it is not looking at. Both tables are counts,
// instants and stable codes: nothing here is a health value.

import { endpoints } from "../api/endpoints.ts";
import { formatBytes, formatDateTime, formatDuration, relativeTime } from "../lib/format.ts";
import { useLoad } from "../lib/use-load.ts";

import PhoneStatusPill from "./PhoneStatusPill.vue";
import StateBlock from "./StateBlock.vue";

const props = defineProps<{ deviceId: string; timezone: string | null }>();

const coverage = useLoad((signal) => endpoints.deviceCoverage(props.deviceId, signal));
const log = useLoad((signal) => endpoints.deviceIngestLog(props.deviceId, signal));

function count(value: number | null): string {
  return value === null ? "—" : value.toLocaleString();
}
</script>

<template>
  <div class="details">
    <h3>Record types</h3>
    <StateBlock
      :loading="coverage.loading.value"
      :error="coverage.error.value"
      :empty="(coverage.data.value ?? []).length === 0"
      empty-text="The phone has not reported any record types yet."
      loading-text="Loading record types…"
      @retry="coverage.reload()"
    >
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Permission</th>
              <th class="num">Records</th>
              <th>First</th>
              <th>Last</th>
              <th class="num">Backlog</th>
              <th>Backfill</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in coverage.data.value ?? []" :key="row.recordType">
              <td class="nowrap">{{ row.recordType }}</td>
              <td class="nowrap" :class="{ 'danger-text': row.permission === 'denied' }">
                {{ row.permission }}
              </td>
              <td class="num">{{ count(row.recordCount) }}</td>
              <td class="nowrap" :title="formatDateTime(row.firstAt, timezone)">
                {{ row.firstAt ? relativeTime(row.firstAt) : "—" }}
              </td>
              <td class="nowrap" :title="formatDateTime(row.lastAt, timezone)">
                {{ row.lastAt ? relativeTime(row.lastAt) : "—" }}
              </td>
              <td class="num">{{ count(row.backlog) }}</td>
              <td class="nowrap">{{ row.backfillComplete ? "complete" : "in progress" }}</td>
              <td>
                <PhoneStatusPill :status="row.status" />
                <p v-if="row.notice" class="muted">{{ row.notice }}</p>
                <p v-else-if="row.permission === 'granted' && row.recordCount === 0" class="muted">
                  Permitted, no data.
                </p>
                <p v-else-if="row.ageHours !== null" class="muted">
                  No upload for {{ row.ageHours }} h.
                </p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </StateBlock>

    <h3>Recent uploads</h3>
    <StateBlock
      :loading="log.loading.value"
      :error="log.error.value"
      :empty="(log.data.value ?? []).length === 0"
      empty-text="Nothing has been uploaded yet."
      loading-text="Loading uploads…"
      @retry="log.reload()"
    >
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Received</th>
              <th>Status</th>
              <th class="num">Upserts</th>
              <th class="num">Deletes</th>
              <th class="num">Rejected</th>
              <th class="num">Size</th>
              <th class="num">Took</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(batch, index) in log.data.value ?? []" :key="index">
              <td class="nowrap" :title="formatDateTime(batch.receivedAt, timezone)">
                {{ relativeTime(batch.receivedAt) }}
              </td>
              <td class="nowrap" :class="{ 'danger-text': batch.status === 'failed' }">
                {{ batch.status }}
              </td>
              <td class="num">{{ count(batch.upserts) }}</td>
              <td class="num">{{ count(batch.deletes) }}</td>
              <td class="num">{{ count(batch.rejected) }}</td>
              <td class="num nowrap">{{ formatBytes(batch.bodyBytes) }}</td>
              <td class="num nowrap">
                {{ batch.applyMs === null ? "—" : formatDuration(batch.applyMs) }}
              </td>
              <td class="nowrap">{{ batch.errorCode ?? "—" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </StateBlock>
  </div>
</template>

<style scoped>
.details {
  display: grid;
  gap: 10px;
}

h3 {
  font-size: 0.95rem;
}

.muted {
  margin: 2px 0 0;
}
</style>
