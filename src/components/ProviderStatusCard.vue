<script setup lang="ts">
// One provider's health, on the overview.
//
// Read-only apart from Reconnect: editing lives on /providers. The Reconnect
// link is a real anchor because the OAuth start is a Worker route that redirects
// off-origin -- a fetch could not follow it and a router push would not leave.

import { computed } from "vue";

import { humanizeCode, isPast, relativeTime } from "../lib/format.ts";
import { reconnectHref } from "../lib/oauth.ts";

import StatusPill from "./StatusPill.vue";

import type { ProviderDto } from "@shared/types.ts";

const props = defineProps<{ provider: ProviderDto }>();

const connection = computed(() => props.provider.connection);
const status = computed(() => connection.value?.status ?? "disconnected");
const expired = computed(() => isPast(connection.value?.accessExpiresAt));
const href = computed(() => reconnectHref(props.provider));
</script>

<template>
  <article class="card">
    <div class="head">
      <h3>{{ provider.displayName }}</h3>
      <span v-if="provider.environment === 'sandbox'" class="chip env">sandbox</span>
      <StatusPill :status="status" />
    </div>

    <dl class="facts">
      <div>
        <dt>Token</dt>
        <dd :class="{ 'danger-text': expired }">
          {{ connection?.accessExpiresAt ? relativeTime(connection.accessExpiresAt) : "—" }}
        </dd>
      </div>
      <div>
        <dt>Last sync</dt>
        <dd>{{ relativeTime(connection?.lastSyncAt) }}</dd>
      </div>
      <div>
        <dt>Last full refresh</dt>
        <dd>{{ relativeTime(connection?.lastFullRefreshAt) }}</dd>
      </div>
      <div v-if="connection?.lastErrorCode">
        <dt>Last error</dt>
        <dd class="danger-text">{{ humanizeCode(connection.lastErrorCode) }}</dd>
      </div>
    </dl>

    <p v-if="provider.config.enabled === false" class="muted">Sync is switched off.</p>
    <p v-else-if="!provider.hasClientSecret" class="muted">
      No client secret set yet — connecting will fail until one is.
    </p>

    <div class="row">
      <a v-if="status === 'connected'" class="btn small" :href="href">Reconnect</a>
      <a v-else class="btn small primary" :href="href">
        {{ status === "needs_reauth" ? "Reconnect" : "Connect" }}
      </a>
      <RouterLink class="btn small spacer" to="/providers">Configure</RouterLink>
    </div>
  </article>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

h3 {
  font-size: 1rem;
}

.env {
  border-color: color-mix(in srgb, var(--warn) 40%, transparent);
  color: var(--warn);
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
