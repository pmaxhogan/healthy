<script setup lang="ts">
// The run log. Every scheduled and manual run, with its summary counts.

import { computed } from "vue";

import { endpoints } from "../api/endpoints.ts";
import RunsTable from "../components/RunsTable.vue";
import StateBlock from "../components/StateBlock.vue";
import { toastSuccess } from "../lib/toasts.ts";
import { useAction, useLoad } from "../lib/use-load.ts";

const runs = useLoad((signal) => endpoints.runs(signal));
const settings = useLoad((signal) => endpoints.settings(signal));
const manual = useAction();

const timezone = computed(() => settings.data.value?.timezone ?? null);

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
