<script setup lang="ts">
// The landing page: is everything connected, did the last sync work, and is
// anything asking for attention.
//
// One request (`GET /api/overview`) fills the whole page. That is deliberate --
// seven panels each fetching their own slice would make the first paint the
// slowest thing in the app.

import { computed, onMounted } from "vue";
import { useRoute } from "vue-router";

import { endpoints } from "../api/endpoints.ts";
import AlertsList from "../components/AlertsList.vue";
import ProviderStatusCard from "../components/ProviderStatusCard.vue";
import RunsTable from "../components/RunsTable.vue";
import StateBlock from "../components/StateBlock.vue";
import StatusPill from "../components/StatusPill.vue";
import { maskAccount, maskCalendarId, relativeTime } from "../lib/format.ts";
import { GOOGLE_START } from "../lib/oauth.ts";
import { toastSuccess } from "../lib/toasts.ts";
import { useAction, useLoad } from "../lib/use-load.ts";

const route = useRoute();
const overview = useLoad((signal) => endpoints.overview(signal));
const sync = useAction();

const timezone = computed(() => overview.data.value?.settings.timezone ?? null);
const providers = computed(() => overview.data.value?.providers ?? []);
const providerNames = computed(() =>
  Object.fromEntries(providers.value.map((p) => [p.id, p.displayName])),
);

/** Resource types that any provider has something cached for, alphabetically. */
const cacheRows = computed(() => {
  const counts = overview.data.value?.cacheCounts ?? [];
  const types = [...new Set(counts.map((c) => c.resourceType))].toSorted((a, b) =>
    a.localeCompare(b),
  );
  const byKey = new Map(counts.map((c) => [`${c.providerId}\u{0}${c.resourceType}`, c.count]));
  return types.map((resourceType) => ({
    resourceType,
    cells: providers.value.map((p) => byKey.get(`${p.id}\u{0}${resourceType}`) ?? 0),
  }));
});

onMounted(() => {
  // The OAuth callbacks come back to the SPA with a query flag rather than a
  // toast of their own, because they are server redirects and cannot reach into
  // a running page.
  const connected = route.query.connected;
  const google = route.query.google;
  if (typeof connected === "string" && connected !== "") {
    toastSuccess("Provider connected.");
  } else if (google === "connected") {
    toastSuccess("Google Calendar connected.");
  }
});

async function runSyncNow(): Promise<void> {
  const ok = await sync.run(async () => {
    await endpoints.runSync();
    toastSuccess("Sync started.");
  });
  if (ok) await overview.reload();
}
</script>

<template>
  <div class="page">
    <StateBlock
      :loading="overview.loading.value"
      :error="overview.error.value"
      loading-text="Loading the overview…"
      @retry="overview.reload()"
    >
      <template v-if="overview.data.value">
        <section class="card">
          <div class="row">
            <h2>Providers</h2>
            <button class="small spacer" :disabled="sync.busy.value" @click="runSyncNow">
              {{ sync.busy.value ? "Syncing…" : "Sync all now" }}
            </button>
          </div>
          <p v-if="providers.length === 0" class="muted">
            No providers yet. Add one on the
            <RouterLink to="/providers">Providers</RouterLink> page.
          </p>
          <div v-else class="cards">
            <ProviderStatusCard
              v-for="provider in providers"
              :key="provider.id"
              :provider="provider"
            />
          </div>
        </section>

        <section class="card">
          <div class="row">
            <h2>Google Calendar</h2>
            <StatusPill :status="overview.data.value.google.status" />
          </div>
          <dl class="facts">
            <div>
              <dt>Account</dt>
              <dd>{{ maskAccount(overview.data.value.google.accountLabel) }}</dd>
            </div>
            <div>
              <dt>Calendar</dt>
              <dd>{{ maskCalendarId(overview.data.value.google.calendarId) }}</dd>
            </div>
            <div>
              <dt>Token</dt>
              <dd>{{ relativeTime(overview.data.value.google.accessExpiresAt) }}</dd>
            </div>
            <div>
              <dt>Events</dt>
              <dd>
                {{ overview.data.value.calendarEvents.active }} active ·
                {{ overview.data.value.calendarEvents.ghost }} ghost
              </dd>
            </div>
          </dl>
          <div class="row">
            <a
              class="btn small"
              :class="{ primary: overview.data.value.google.status !== 'connected' }"
              :href="GOOGLE_START"
            >
              {{ overview.data.value.google.status === "not_connected" ? "Connect" : "Reconnect" }}
            </a>
            <RouterLink class="btn small spacer" to="/calendar">Calendar settings</RouterLink>
          </div>
        </section>

        <section class="card">
          <h2>Open alerts</h2>
          <p v-if="overview.data.value.openAlerts.length === 0" class="muted">
            Nothing needs re-authenticating.
          </p>
          <AlertsList
            v-else
            :alerts="overview.data.value.openAlerts"
            :timezone="timezone"
            :provider-names="providerNames"
          />
        </section>

        <section class="card">
          <div class="row">
            <h2>Last runs</h2>
            <RouterLink class="btn small spacer" to="/runs">All runs</RouterLink>
          </div>
          <p v-if="overview.data.value.lastRuns.length === 0" class="muted">Nothing has run yet.</p>
          <RunsTable v-else :runs="overview.data.value.lastRuns" :timezone="timezone" />
        </section>

        <section class="card">
          <h2>Cached resources</h2>
          <p v-if="cacheRows.length === 0" class="muted">
            The cache is empty. It fills on the daily full refresh.
          </p>
          <div v-else class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Resource</th>
                  <th v-for="provider in providers" :key="provider.id" class="num">
                    {{ provider.displayName }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in cacheRows" :key="row.resourceType">
                  <td class="nowrap">{{ row.resourceType }}</td>
                  <td v-for="(count, i) in row.cells" :key="i" class="num">{{ count }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="card">
          <div class="row">
            <h2>MCP</h2>
            <span class="chip">{{ overview.data.value.mcp.enabled ? "enabled" : "disabled" }}</span>
            <RouterLink class="btn small spacer" to="/connectors">Manage</RouterLink>
          </div>
          <dl class="facts">
            <div>
              <dt>Linked clients</dt>
              <dd>{{ overview.data.value.mcp.grants }}</dd>
            </div>
            <div>
              <dt>Calls (24 h)</dt>
              <dd>{{ overview.data.value.mcp.auditLast24h }}</dd>
            </div>
            <div>
              <dt>Policy rules</dt>
              <dd>{{ overview.data.value.mcp.policyRules }}</dd>
            </div>
          </dl>
        </section>
      </template>
    </StateBlock>
  </div>
</template>

<style scoped>
h2 {
  font-size: 1.05rem;
}

.cards {
  display: grid;
  gap: 12px;
}

@media (min-width: 720px) {
  .cards {
    grid-template-columns: 1fr 1fr;
  }
}

.facts {
  margin: 0;
  display: grid;
  gap: 6px 16px;
  grid-template-columns: 1fr;
  font-size: 0.88rem;
}

@media (min-width: 420px) {
  .facts {
    grid-template-columns: 1fr 1fr;
  }
}

.facts > div {
  display: flex;
  gap: 8px;
  min-width: 0;
}

dt {
  color: var(--text-dim);
  flex: none;
}

dd {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
