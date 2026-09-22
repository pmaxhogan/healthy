<script setup lang="ts">
// Reconnect alerts, and a way to prove the alert channel works without waiting
// for something to break.

import { computed, ref } from "vue";

import { endpoints } from "../api/endpoints.ts";
import AlertsList from "../components/AlertsList.vue";
import StateBlock from "../components/StateBlock.vue";
import { toastSuccess } from "../lib/toasts.ts";
import { useAction, useLoad } from "../lib/use-load.ts";

const alerts = useLoad((signal) => endpoints.alerts(signal));
const providers = useLoad((signal) => endpoints.providers(signal));
const settings = useLoad((signal) => endpoints.settings(signal));

const testAction = useAction();
const archiveAction = useAction();
const testCardId = ref<string | null>(null);

const timezone = computed(() => settings.data.value?.timezone ?? null);
const providerNames = computed(() =>
  Object.fromEntries((providers.data.value ?? []).map((p) => [p.id, p.displayName])),
);
const open = computed(() => (alerts.data.value ?? []).filter((a) => a.resolvedAt === null));
const recent = computed(() => (alerts.data.value ?? []).filter((a) => a.resolvedAt !== null));

async function sendTest(): Promise<void> {
  await testAction.run(async () => {
    const created = await endpoints.sendTestAlert();
    testCardId.value = created.cardId;
    toastSuccess("Test card created.");
  });
}

async function archiveTest(): Promise<void> {
  const id = testCardId.value;
  if (id === null) return;
  const ok = await archiveAction.run(async () => {
    await endpoints.archiveTestAlert(id);
    toastSuccess("Test card archived.");
  });
  if (ok) testCardId.value = null;
}
</script>

<template>
  <div class="page">
    <section class="card">
      <h2>Open alerts</h2>
      <StateBlock
        :loading="alerts.loading.value"
        :error="alerts.error.value"
        :empty="open.length === 0"
        empty-text="Nothing needs re-authenticating."
        @retry="alerts.reload()"
      >
        <AlertsList :alerts="open" :timezone="timezone" :provider-names="providerNames" />
      </StateBlock>
    </section>

    <section v-if="recent.length > 0" class="card">
      <h2>Resolved</h2>
      <AlertsList :alerts="recent" :timezone="timezone" :provider-names="providerNames" />
    </section>

    <section class="card">
      <h2>Test the alert channel</h2>
      <p class="muted">
        Opens a card on the board the real alerts use, so a broken key shows up here rather than the
        next time a connection actually expires.
      </p>
      <div class="row">
        <button :disabled="testAction.busy.value" @click="sendTest">
          {{ testAction.busy.value ? "Sending…" : "Send test card" }}
        </button>
        <template v-if="testCardId !== null">
          <code class="card-id">{{ testCardId }}</code>
          <button class="small" :disabled="archiveAction.busy.value" @click="archiveTest">
            {{ archiveAction.busy.value ? "Archiving…" : "Archive test card" }}
          </button>
        </template>
      </div>
    </section>
  </div>
</template>

<style scoped>
h2 {
  font-size: 1.05rem;
}

.card-id {
  background: var(--bg-input);
  border-radius: 6px;
  padding: 4px 8px;
  overflow-wrap: anywhere;
}
</style>
