<script setup lang="ts">
// The Google Health side of the Google grant: whether the owner has granted the
// read scopes, and per metric how much is stored and how the last read went.
// Bookkeeping only; the values themselves are served over the MCP.

import { computed } from "vue";

import { endpoints } from "../api/endpoints.ts";
import { relativeTime } from "../lib/format.ts";
import { toastSuccess } from "../lib/toasts.ts";
import { useAction, useLoad } from "../lib/use-load.ts";

import StateBlock from "./StateBlock.vue";

const health = useLoad((signal) => endpoints.googleHealth(signal));
const sync = useAction();

const googleConnected = computed(() => health.data.value?.googleStatus === "connected");

/** `DailyOxygenSaturation` -> `Daily oxygen saturation`. */
function label(type: string): string {
  const words = type.replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

async function onSync(full: boolean): Promise<void> {
  await sync.run(async () => {
    await endpoints.syncGoogleHealth(full);
    toastSuccess(
      full
        ? "Reading every metric's whole history. This can take a minute."
        : "Reading the last two weeks.",
    );
  });
}
</script>

<template>
  <section class="card">
    <h2>Google Health (Fitbit)</h2>
    <StateBlock
      :loading="health.loading.value"
      :error="health.error.value"
      loading-text="Checking Google Health..."
      @retry="health.reload()"
    >
      <template v-if="health.data.value">
        <p class="muted">
          Blood-oxygen saturation, the nightly HRV breakdown, VO2 max, skin-temperature baseline,
          heart-rate zones and active zone minutes, read hourly from the Google Health API with the
          Google grant above. Health Connect does not carry these.
        </p>
        <p v-if="!googleConnected" class="muted">Connect Google first.</p>
        <p v-else-if="!health.data.value.granted" class="muted">
          <strong>Choose the same Google account as the calendar above</strong> on Google's account
          picker: the grant replaces the calendar's, so another account would move the calendar sync
          to it. That account must be the one your Fitbit is signed in to.
        </p>
        <template v-else>
          <div class="row">
            <a
              class="btn"
              :class="{ primary: !health.data.value.granted }"
              :href="health.data.value.connectPath"
            >
              {{ health.data.value.granted ? "Grant again" : "Grant Google Health access" }}
            </a>
            <template v-if="health.data.value.granted">
              <button class="small" :disabled="sync.busy.value" @click="onSync(false)">
                Sync now
              </button>
              <button class="small" :disabled="sync.busy.value" @click="onSync(true)">
                Re-read all history
              </button>
            </template>
          </div>
          <table v-if="health.data.value.granted" class="table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>Days</th>
                <th>From</th>
                <th>To</th>
                <th>Last read</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in health.data.value.types" :key="row.type">
                <td>{{ label(row.type) }}</td>
                <td>{{ row.scopeGranted ? row.days : "not granted" }}</td>
                <td>{{ row.firstDate ?? "-" }}</td>
                <td>{{ row.lastDate ?? "-" }}</td>
                <td>
                  <span v-if="row.lastErrorCode" class="danger-text">{{ row.lastErrorCode }}</span>
                  <span v-else>{{ relativeTime(row.lastOkAt) }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </template>
      </template>
    </StateBlock>
  </section>
</template>
