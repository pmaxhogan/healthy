<script setup lang="ts">
// The run log. Every scheduled and manual run, with its summary counts.
//
// A run's work happens after the 202 that starts it, so the row this page shows
// first is usually still `running`. Rather than one reload that is likely to land
// mid-flight, this polls `GET /api/runs` every few seconds for as long as any row
// is running, and stops on its own once none is (or after a couple of minutes, so
// a run stuck forever does not poll forever).

import { computed, onUnmounted, watch } from "vue";

import { endpoints } from "../api/endpoints.ts";
import RunsTable from "../components/RunsTable.vue";
import StateBlock from "../components/StateBlock.vue";
import { toastSuccess } from "../lib/toasts.ts";
import { useAction, useLoad } from "../lib/use-load.ts";

import type { RunDto } from "@shared/types.ts";

/** How often to ask again while a run is still going. */
const POLL_INTERVAL_MS = 3000;
/** Give up polling after this long. A run stuck past it needs a human, not a poll. */
const POLL_MAX_MS = 2 * 60 * 1000;

const runs = useLoad((signal) => endpoints.runs(signal));
const settings = useLoad((signal) => endpoints.settings(signal));
const manual = useAction();

const timezone = computed(() => settings.data.value?.timezone ?? null);

function isRunning(run: RunDto): boolean {
  return run.ok === null;
}

// A plain mutable object rather than top-level `let`s: the interval handle and
// its deadline are reassigned from inside the functions below, and a top-level
// binding reassigned that way is easy to lose track of across a hot reload.
const poll: { handle: ReturnType<typeof setInterval> | null; deadline: number } = {
  handle: null,
  deadline: 0,
};

function stopPolling(): void {
  if (poll.handle === null) return;
  clearInterval(poll.handle);
  poll.handle = null;
}

/**
 * One poll tick: fetch and swap in the fresh list without touching `loading`, so
 * the table does not flash a spinner every three seconds.
 */
async function pollOnce(): Promise<void> {
  if (Date.now() >= poll.deadline) {
    stopPolling();
    return;
  }
  let latest: RunDto[];
  try {
    latest = await endpoints.runs();
  } catch {
    // A transient failure just waits for the next tick -- a real problem is still
    // there next time, and the owner can always press Refresh.
    return;
  }
  runs.set(latest);
  if (latest.every((run) => !isRunning(run))) stopPolling();
}

function startPolling(): void {
  if (poll.handle !== null) return;
  poll.deadline = Date.now() + POLL_MAX_MS;
  poll.handle = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
}

// Fires on the initial load, on every reload, and on every poll tick's own
// `runs.set` -- the last case is a no-op because `startPolling` is already
// guarded, so the two-minute deadline set on first entry is never pushed out.
watch(runs.data, (value) => {
  if (value?.some((run) => isRunning(run)) === true) startPolling();
});

onUnmounted(() => {
  stopPolling();
});

async function runNow(): Promise<void> {
  const ok = await manual.run(async () => {
    await endpoints.runSync();
    toastSuccess("Sync started.");
  });
  if (ok) await runs.reload();
}
</script>

<template>
  <div class="page">
    <section class="card">
      <div class="row">
        <h2>Runs</h2>
        <button class="small" :disabled="runs.loading.value" @click="runs.reload()">Refresh</button>
        <button class="small spacer" :disabled="manual.busy.value" @click="runNow">
          {{ manual.busy.value ? "Syncing…" : "Sync now" }}
        </button>
      </div>
      <p class="muted">
        Summaries are counts only — no appointment, practitioner or clinical detail is written to
        the log.
      </p>

      <StateBlock
        :loading="runs.loading.value"
        :error="runs.error.value"
        :empty="(runs.data.value ?? []).length === 0"
        empty-text="Nothing has run yet. The hourly sync fills this in."
        loading-text="Loading runs…"
        @retry="runs.reload()"
      >
        <RunsTable :runs="runs.data.value ?? []" :timezone="timezone" expandable />
      </StateBlock>
    </section>
  </div>
</template>

<style scoped>
h2 {
  font-size: 1.05rem;
}
</style>
