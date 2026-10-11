<script setup lang="ts">
// The Phone page: pair a phone running the companion app, and see what each
// paired phone has uploaded.
//
// Pairing mints a token on the Worker and shows it here exactly once, as a QR
// code and as text. This page is the only holder of it: `paired` is cleared when
// the owner presses Done, and leaving the page drops it with the component.

import { computed, onMounted, onUnmounted, ref, watch } from "vue";

import { endpoints } from "../api/endpoints.ts";
import DeviceCard from "../components/DeviceCard.vue";
import PairingPanel from "../components/PairingPanel.vue";
import StateBlock from "../components/StateBlock.vue";
import { toastError, toastSuccess } from "../lib/toasts.ts";
import { useAction, useLoad } from "../lib/use-load.ts";

import type { PairedDeviceDto } from "@shared/types.ts";

/** What the owner pastes into Obtainium to install and update the companion app. */
const OBTAINIUM_LINK = "obtainium://add/https://github.com/pmaxhogan/healthy";

const devices = useLoad((signal) => endpoints.devices(signal));
// Only for how instants are shown. A failure to load it is not worth blocking the
// page for: times fall back to the browser's own zone.
const settings = useLoad((signal) => endpoints.settings(signal));
const create = useAction();

const timezone = computed(() => settings.data.value?.timezone ?? null);
const list = computed(() => devices.data.value ?? []);

const name = ref("");
const nameValid = computed(() => name.value.trim() !== "");
const paired = ref<PairedDeviceDto | null>(null);

async function pair(): Promise<void> {
  if (!nameValid.value) return;
  const ok = await create.run(async () => {
    paired.value = await endpoints.createDevice({ name: name.value.trim() });
    toastSuccess("Phone added. Scan the code before leaving this page.");
  });
  if (!ok) {
    return;
  }

  name.value = "";
  await devices.reload();
}

async function copyLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(OBTAINIUM_LINK);
    toastSuccess("Link copied.");
  } catch {
    toastError("Could not copy. Select the link and copy it by hand.");
  }
}

async function reloadDevices(): Promise<void> {
  await devices.reload();
}

// --- live refresh -----------------------------------------------------------
//
// A backfill runs for hours and this page is where the owner watches it, so the
// list (and whichever details are open, through `refreshTick`) is fetched again
// every `REFRESH_MS` while the page is on screen. Quietly: the fresh list is
// swapped in with `set`, never `reload`, so nothing blanks, no card loses its
// open details and the scroll position stays where it was. A hidden tab does
// not fetch, and catches up the moment it is shown again.

const REFRESH_MS = 15_000;
const CLOCK_MS = 1000;

/** The page's clock: what every relative time on it is relative to. */
const now = ref(Date.now());
const refreshedAt = ref<number | null>(null);
const refreshTick = ref(0);
const refreshing = ref(false);
const clock: { handle: ReturnType<typeof setInterval> | null; askedAt: number } = {
  handle: null,
  askedAt: Date.now(),
};

watch(devices.data, () => {
  refreshedAt.value = Date.now();
});

async function refresh(): Promise<void> {
  // One at a time, and never across a load the page is already showing.
  if (refreshing.value || devices.loading.value) return;
  clock.askedAt = Date.now();
  if (devices.error.value !== null) {
    await devices.reload();
    return;
  }
  refreshing.value = true;
  refreshTick.value += 1;
  try {
    devices.set(await endpoints.devices());
  } catch {
    // A refresh that fails waits for the next one; "Updated" keeps saying how
    // old what is on screen is.
  } finally {
    refreshing.value = false;
  }
}

function tick(): void {
  if (document.visibilityState === "hidden") return;
  now.value = Date.now();
  if (now.value - clock.askedAt >= REFRESH_MS) void refresh();
}

onMounted(() => {
  clock.handle = setInterval(tick, CLOCK_MS);
  document.addEventListener("visibilitychange", tick);
});

onUnmounted(() => {
  if (clock.handle !== null) clearInterval(clock.handle);
  document.removeEventListener("visibilitychange", tick);
});

const updatedText = computed(() => {
  if (refreshedAt.value === null) return "";
  const seconds = Math.max(0, Math.round((now.value - refreshedAt.value) / 1000));
  if (seconds < 5) return "Updated just now";
  return seconds < 120
    ? `Updated ${String(seconds)} s ago`
    : `Updated ${String(Math.round(seconds / 60))} min ago`;
});
</script>

<template>
  <div class="page">
    <PairingPanel v-if="paired" :paired="paired" @done="paired = null" />

    <section v-if="!paired" class="card">
      <h2>Pair a phone</h2>
      <p class="muted">
        Each phone gets its own token, which you can revoke or rotate here. The token is shown once,
        right after you press the button.
      </p>
      <form class="row" @submit.prevent="pair">
        <label class="field grow">
          Name for this phone
          <input
            v-model="name"
            maxlength="60"
            autocomplete="off"
            placeholder="For example: my phone"
            :disabled="create.busy.value"
          />
        </label>
        <button type="submit" class="primary" :disabled="!nameValid || create.busy.value">
          {{ create.busy.value ? "Pairing…" : "Pair a phone" }}
        </button>
      </form>
    </section>

    <StateBlock
      :loading="devices.loading.value && devices.data.value === null"
      :error="devices.error.value"
      :empty="list.length === 0"
      empty-text="No phones are paired yet. Give one a name above to pair it."
      loading-text="Loading phones…"
      @retry="reloadDevices"
    >
      <div class="row refresh">
        <span class="muted">{{ updatedText }} · refreshes every {{ REFRESH_MS / 1000 }} s</span>
        <button type="button" class="small" :disabled="refreshing" @click="refresh">
          {{ refreshing ? "Refreshing…" : "Refresh" }}
        </button>
      </div>
      <DeviceCard
        v-for="device in list"
        :key="device.id"
        :device="device"
        :timezone="timezone"
        :now="now"
        :refresh-tick="refreshTick"
        @changed="reloadDevices"
        @paired="paired = $event"
      />
    </StateBlock>

    <section class="card">
      <h2>Install the companion app</h2>
      <p class="muted">
        On the phone, open this link in Obtainium, or paste it into Obtainium's Add app box. It
        installs the app and keeps it up to date.
      </p>
      <div class="row">
        <code class="link">{{ OBTAINIUM_LINK }}</code>
        <button type="button" class="small" @click="copyLink">Copy link</button>
      </div>
      <p class="muted">
        Step-by-step setup, including the Health Connect permissions, is in
        <code>docs/setup-android.md</code>.
      </p>
    </section>
  </div>
</template>

<style scoped>
h2 {
  font-size: 1.05rem;
}

.grow {
  flex: 1;
}

.refresh {
  justify-content: flex-end;
}

.link {
  overflow-wrap: anywhere;
}
</style>
