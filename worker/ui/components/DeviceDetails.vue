<script setup lang="ts">
// One phone's per-record-type coverage and its uploads.
//
// Mounted only when the owner opens a device's details, so the page does not
// fetch these per phone it is not looking at. Everything here is counts,
// instants and stable codes: nothing is a health value.
//
// A type the owner has not granted is shown as exactly that, in the same grey as
// anything else that is not a fault: declining a type the phone has no data for
// is the normal way to set the app up. Types with nothing stored are folded away
// under one button, so the table is the data there is.
//
// After the first load nothing here blanks: the page's refresh (`refreshTick`),
// a change of filter and "Show more" all fetch quietly and swap the rows in.

import { computed, ref, watch } from "vue";

import { errorMessage, isAuthRequired } from "../api/client.ts";
import { endpoints } from "../api/endpoints.ts";
import {
  formatBytes,
  formatDate,
  formatDateTime,
  formatDuration,
  relativeTime,
} from "../lib/format.ts";
import { toastError } from "../lib/toasts.ts";
import { useLoad } from "../lib/use-load.ts";

import PhoneStatusPill from "./PhoneStatusPill.vue";
import RelTime from "./RelTime.vue";
import StateBlock from "./StateBlock.vue";

import type {
  DeviceCoverageRowDto,
  DeviceIngestLogDto,
  DeviceIngestLogState,
  DeviceIngestSummaryDto,
} from "@shared/types.ts";

const props = defineProps<{
  deviceId: string;
  timezone: string | null;
  /** The page's clock, so relative times tick. */
  now: number;
  /** Bumped by the page each time it refreshes: fetch again, quietly. */
  refreshTick: number;
}>();

type LogFilter = DeviceIngestLogState | "all";

/** How many uploads are listed, and what "Show more" steps to. The Worker refuses more than the last. */
const LOG_STEPS = [50, 200, 500] as const;
const LOG_CEILING = 500;

interface Uploads {
  summary: DeviceIngestSummaryDto;
  rows: DeviceIngestLogDto[];
  /** What `rows` was asked for, which is what its caption describes. */
  filter: LogFilter;
  limit: number;
}

const filter = ref<LogFilter | null>(null);
const limit = ref<number>(LOG_STEPS[0]);

/**
During a backfill the newest uploads are all still waiting, so a list of the
newest shows no progress at all. Start on the finished ones exactly then.
*/
function startingFilter(summary: DeviceIngestSummaryDto): LogFilter {
  const waiting = summary.queued + summary.applying;
  return waiting >= LOG_STEPS[0] && summary.applied + summary.failed > 0 ? "finished" : "all";
}

async function fetchUploads(signal?: AbortSignal): Promise<Uploads> {
  const summary = await endpoints.deviceIngestSummary(props.deviceId, signal);
  filter.value ??= startingFilter(summary);
  const asked = { filter: filter.value, limit: limit.value };
  const rows = await endpoints.deviceIngestLog(
    props.deviceId,
    { limit: asked.limit, state: asked.filter === "all" ? null : asked.filter },
    signal,
  );
  return { summary, rows, ...asked };
}

const coverage = useLoad((signal) => endpoints.deviceCoverage(props.deviceId, signal));
const uploads = useLoad((signal) => fetchUploads(signal));

// --- record types -----------------------------------------------------------

function hasData(row: DeviceCoverageRowDto): boolean {
  return row.recordCount > 0;
}

const rows = computed(() => coverage.data.value ?? []);
const withData = computed(() => rows.value.filter((row) => hasData(row)));
/** Types with nothing stored: the granted ones first, then the rest. */
const withoutData = computed(() => {
  const empty = rows.value.filter((row) => !hasData(row));
  return [
    ...empty.filter((row) => row.permission === "granted"),
    ...empty.filter((row) => row.permission !== "granted"),
  ];
});
const emptyGranted = computed(
  () => withoutData.value.filter((row) => row.permission === "granted").length,
);

const emptyChoice = ref<boolean | null>(null);
/** Open by default only when there is nothing else to show. */
const showEmpty = computed(() => emptyChoice.value ?? withData.value.length === 0);
const shownRows = computed(() =>
  showEmpty.value ? [...withData.value, ...withoutData.value] : withData.value,
);

const emptySummary = computed(() => {
  const total = withoutData.value.length;
  const notGranted = total - emptyGranted.value;
  const parts = [
    emptyGranted.value > 0 ? `${String(emptyGranted.value)} granted` : "",
    notGranted > 0 ? `${String(notGranted)} not granted` : "",
  ].filter(Boolean);
  return `${String(total)} type${total === 1 ? "" : "s"} with no data (${parts.join(", ")})`;
});

/** The word for a type the phone does not read, or null for one it does. */
function permissionWord(row: DeviceCoverageRowDto): string | null {
  if (row.permission === "denied") return "not granted";
  return row.permission === "unavailable" ? "not available" : null;
}

/** One short line under the status, or null. Never the Worker's long notice. */
function statusNote(row: DeviceCoverageRowDto): string | null {
  if (row.permission === "denied") {
    return hasData(row) ? "Stored data is kept." : null;
  }
  if (row.permission === "unavailable") return null;
  if (row.ageHours !== null) return `No upload for ${String(row.ageHours)} h.`;
  return row.permission === "granted" && !hasData(row) ? "Granted, no data." : null;
}

function count(value: number | null): string {
  return value === null ? "—" : value.toLocaleString();
}

// --- uploads ----------------------------------------------------------------

const FILTERS: readonly { value: LogFilter; label: string }[] = [
  { value: "finished", label: "Finished" },
  { value: "waiting", label: "Waiting" },
  { value: "all", label: "All" },
];

function matching(summary: DeviceIngestSummaryDto, which: LogFilter): number {
  if (which === "finished") return summary.applied + summary.failed;
  return which === "waiting" ? summary.queued + summary.applying : summary.total;
}

const NOUNS: Record<LogFilter, string> = {
  finished: "finished uploads",
  waiting: "waiting uploads",
  all: "uploads",
};

const logCaption = computed(() => {
  const held = uploads.data.value;
  if (held === null) return "";
  // The two were read a moment apart, so the count can trail the rows by one.
  const of = Math.max(matching(held.summary, held.filter), held.rows.length);
  const noun = NOUNS[held.filter];
  return held.rows.length < of
    ? `Newest ${held.rows.length.toLocaleString()} of ${of.toLocaleString()} ${noun}`
    : `All ${of.toLocaleString()} ${noun}`;
});

const hasMore = computed(() => {
  const held = uploads.data.value;
  return held !== null && held.rows.length < matching(held.summary, held.filter);
});
const nextLimit = computed(() => LOG_STEPS.find((step) => step > limit.value) ?? null);

/** Batches that could not be applied. The log and the queue agree unless one was read mid-change. */
const failedCount = computed(() => {
  const summary = uploads.data.value?.summary;
  return summary ? Math.max(summary.failed, summary.parked) : 0;
});

// One mutable object rather than top-level `let`s (see RunsView): which quiet
// fetches are in flight, and how many times the uploads have been asked for.
const quiet = { coverage: false, uploads: false, asked: 0 };

/** Fetch the uploads again without blanking the table. A newer ask wins over an older answer. */
async function refreshUploads(byOwner: boolean): Promise<void> {
  if (!byOwner && (quiet.uploads || uploads.data.value === null)) return;
  quiet.asked += 1;
  const mine = quiet.asked;
  quiet.uploads = true;
  try {
    const latest = await fetchUploads();
    if (mine === quiet.asked) uploads.set(latest);
  } catch (error) {
    // A background refresh that fails just waits for the next one.
    if (byOwner && !isAuthRequired(error)) toastError(errorMessage(error));
  } finally {
    if (mine === quiet.asked) quiet.uploads = false;
  }
}

async function refreshCoverage(): Promise<void> {
  if (quiet.coverage || coverage.data.value === null) return;
  quiet.coverage = true;
  try {
    coverage.set(await endpoints.deviceCoverage(props.deviceId));
  } catch {
    // As above: the next refresh tries again.
  } finally {
    quiet.coverage = false;
  }
}

watch(
  () => props.refreshTick,
  () => {
    void refreshCoverage();
    void refreshUploads(false);
  },
);

function chooseFilter(value: LogFilter): void {
  if (filter.value === value) return;
  filter.value = value;
  limit.value = LOG_STEPS[0];
  void refreshUploads(true);
}

function showMore(): void {
  if (nextLimit.value === null) return;
  limit.value = nextLimit.value;
  void refreshUploads(true);
}
</script>

<template>
  <div class="details">
    <h3>Record types</h3>
    <StateBlock
      :loading="coverage.loading.value && coverage.data.value === null"
      :error="coverage.error.value"
      :empty="rows.length === 0"
      empty-text="The phone has not reported any record types yet."
      loading-text="Loading record types…"
      @retry="coverage.reload()"
    >
      <p class="muted lead">
        What the phone has reported for each Health Connect record type.
        <span class="scroll-hint">Scroll the table sideways for every column.</span>
      </p>
      <div class="table-wrap sticky" role="region" aria-label="Record types" tabindex="0">
        <table>
          <caption class="unseen">
            Record types the phone has reported
          </caption>
          <thead>
            <tr>
              <th scope="col">Type</th>
              <th scope="col" class="num">Records</th>
              <th scope="col">First – last record</th>
              <th scope="col" class="num">Phone backlog</th>
              <th scope="col">Backfill</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in shownRows" :key="row.recordType" :class="{ quiet: !hasData(row) }">
              <th scope="row" class="nowrap">{{ row.recordType }}</th>
              <td class="num">{{ count(row.recordCount) }}</td>
              <td class="nowrap">
                <template v-if="row.firstAt || row.lastAt">
                  <RelTime :iso="row.firstAt" :timezone="timezone" :now="now" />
                  –
                  <RelTime :iso="row.lastAt" :timezone="timezone" :now="now" />
                </template>
                <template v-else>—</template>
              </td>
              <td class="num">{{ count(row.backlog) }}</td>
              <td class="nowrap">
                <template v-if="row.permission !== 'granted'">—</template>
                <template v-else-if="row.backfillComplete">complete</template>
                <template v-else>
                  in progress
                  <p v-if="row.backfillOldestAt" class="muted">
                    back to {{ formatDate(row.backfillOldestAt, timezone) }}
                  </p>
                </template>
              </td>
              <td class="status">
                <PhoneStatusPill :status="row.status" :label="permissionWord(row)" />
                <p v-if="statusNote(row)" class="muted">{{ statusNote(row) }}</p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="withoutData.length > 0" class="row">
        <button
          type="button"
          class="small"
          :aria-expanded="showEmpty"
          @click="emptyChoice = !showEmpty"
        >
          {{ showEmpty ? "Hide" : "Show" }} {{ emptySummary }}
        </button>
      </div>
    </StateBlock>

    <h3>Uploads</h3>
    <StateBlock
      :loading="uploads.loading.value && uploads.data.value === null"
      :error="uploads.error.value"
      :empty="uploads.data.value?.summary.total === 0"
      empty-text="Nothing has been uploaded yet."
      loading-text="Loading uploads…"
      @retry="uploads.reload()"
    >
      <template v-if="uploads.data.value">
        <ul class="stats" aria-label="Uploads by state">
          <li>
            <strong>{{ uploads.data.value.summary.queued.toLocaleString() }}</strong> queued
          </li>
          <li>
            <strong>{{ uploads.data.value.summary.applying.toLocaleString() }}</strong> applying
          </li>
          <li>
            <strong>{{ uploads.data.value.summary.applied.toLocaleString() }}</strong> applied
            <span class="muted">
              ({{ uploads.data.value.summary.appliedLastHour.toLocaleString() }} in the last hour)
            </span>
          </li>
          <li v-if="failedCount > 0" class="danger-text">
            <strong>{{ failedCount.toLocaleString() }}</strong> could not be applied, kept for Retry
          </li>
          <li v-else class="ok-text">Nothing failed</li>
        </ul>
        <p class="muted">
          Last applied
          <RelTime
            :iso="uploads.data.value.summary.lastAppliedAt"
            :timezone="timezone"
            :now="now"
            empty="never"
          />
          <template v-if="uploads.data.value.summary.applyMsMedian !== null">
            · median apply time
            {{ formatDuration(uploads.data.value.summary.applyMsMedian) }} over the last
            {{ uploads.data.value.summary.applySample }} applied
          </template>
        </p>

        <div class="row" role="group" aria-label="Which uploads to list">
          <button
            v-for="option in FILTERS"
            :key="option.value"
            type="button"
            class="small"
            :class="{ chosen: filter === option.value }"
            :aria-pressed="filter === option.value"
            @click="chooseFilter(option.value)"
          >
            {{ option.label }}
            ({{ matching(uploads.data.value.summary, option.value).toLocaleString() }})
          </button>
        </div>

        <p v-if="uploads.data.value.rows.length === 0" class="muted list-caption">
          No {{ NOUNS[uploads.data.value.filter] }} right now.
        </p>
        <p v-if="uploads.data.value.rows.length > 0" class="muted lead list-caption">
          {{ logCaption }}, newest first.
          <span class="scroll-hint">Scroll the table sideways for every column.</span>
        </p>
        <div
          v-if="uploads.data.value.rows.length > 0"
          class="table-wrap sticky"
          role="region"
          aria-label="Uploads"
          tabindex="0"
        >
          <table>
            <caption class="unseen">
              {{
                logCaption
              }}
            </caption>
            <thead>
              <tr>
                <th scope="col">Received</th>
                <th scope="col">Status</th>
                <th scope="col">Trigger</th>
                <th scope="col" class="num">Upserts</th>
                <th scope="col" class="num">Deletes</th>
                <th scope="col" class="num">Rejected</th>
                <th scope="col" class="num">Size</th>
                <th scope="col" class="num">Took</th>
                <th scope="col">Error</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(batch, index) in uploads.data.value.rows" :key="index">
                <td class="nowrap">
                  <!-- Plain text, not a button: hundreds of rows would be hundreds of tab stops. -->
                  <time
                    :datetime="batch.receivedAt"
                    :title="formatDateTime(batch.receivedAt, timezone)"
                  >
                    {{ relativeTime(batch.receivedAt, now) }}
                  </time>
                </td>
                <td class="nowrap" :class="{ 'danger-text': batch.status === 'failed' }">
                  {{ batch.status }}
                </td>
                <td class="nowrap">{{ batch.runTrigger ?? "—" }}</td>
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
        <div v-if="hasMore" class="row">
          <button v-if="nextLimit !== null" type="button" class="small" @click="showMore">
            Show more
          </button>
          <span v-else class="muted">
            This list stops at the newest {{ LOG_CEILING }}. The counts above cover every upload.
          </span>
        </div>
      </template>
    </StateBlock>
  </div>
</template>

<style scoped>
.details {
  display: grid;
  gap: 10px;
  min-width: 0;
  container-type: inline-size;
}

h3 {
  font-size: 0.95rem;
}

.muted {
  margin: 2px 0 0;
}

.lead {
  font-size: 0.82rem;
}

/* The table's name for a screen reader. What is said about it in sight is the
   line above the scrolling box, which a caption inside it would scroll away. */
.unseen {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* Only said where the table does not fit, which is a question about this box
   and not about the window. */
.scroll-hint {
  display: none;
}

@container (max-width: 880px) {
  .scroll-hint {
    display: inline;
  }
}

/* The first column stays put while the rest scrolls under it, so a row's
   status can be read without losing which type it belongs to. The shared
   wrapper's side padding would let the scrolled cells show beside it. */
.table-wrap.sticky {
  margin: 0;
  padding: 0;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
  /* A shadow on the right edge while there is more to scroll to: the first
     layer travels with the content and covers it at the end. */
  background:
    linear-gradient(to left, var(--bg-raised) 40%, transparent) right center / 36px 100% no-repeat
      local,
    linear-gradient(to left, color-mix(in srgb, var(--text) 22%, transparent), transparent) right
      center / 12px 100% no-repeat scroll;
}

/* Separate borders belong to their cell, so they travel with a sticky one;
   collapsed ones stay behind with the table. */
.table-wrap.sticky table {
  border-collapse: separate;
  border-spacing: 0;
}

.table-wrap.sticky tr > :first-child {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--bg-raised);
  padding-right: 12px;
  border-right: 1px solid var(--border);
}

.table-wrap.sticky tbody > tr:last-child > th {
  border-bottom: none;
}

.table-wrap.sticky tr > :not(:first-child) {
  padding-left: 10px;
}

tbody th {
  color: var(--text);
  font-weight: 500;
}

.quiet > * {
  color: var(--text-dim);
}

/* Room for a pill and one short line, so a note never stretches a row. */
.status {
  min-width: 9rem;
}

.stats {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 18px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 0.9rem;
}

.stats .muted {
  font-size: inherit;
}

.ok-text {
  color: var(--ok);
}

.chosen {
  outline: 1px solid var(--accent);
  color: var(--accent);
}
</style>
