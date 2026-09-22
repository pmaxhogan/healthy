<script setup lang="ts">
// The settings that have no better home, plus the pointers a future reader of
// this deployment needs: where the password comes from, and the public pages.
//
// Most of SettingsDto is edited on /calendar, next to the thing it affects. This
// page shows the rest read-only, so the whole configuration is visible in one
// place.
//
// The backoff clock is deliberately read-only, not a "clear it" button: the
// Worker accepts `syncBackoffUntil` in a settings patch only so the SPA can
// round-trip the DTO it was handed, and then ignores it. A button that reported
// success while changing nothing would be worse than no button.

import { computed } from "vue";

import { endpoints } from "../api/endpoints.ts";
import StateBlock from "../components/StateBlock.vue";
import { formatDateTime, relativeTime } from "../lib/format.ts";
import { toastSuccess } from "../lib/toasts.ts";
import { useAction, useLoad } from "../lib/use-load.ts";

const settings = useLoad((signal) => endpoints.settings(signal));
const toggleMcp = useAction();

const current = computed(() => settings.data.value);

async function onToggleMcp(next: boolean): Promise<void> {
  const ok = await toggleMcp.run(async () => {
    const saved = await endpoints.saveSettings({ mcpEnabled: next });
    settings.set(saved);
    toastSuccess(next ? "MCP enabled." : "MCP disabled.");
  });
  if (!ok) await settings.reload();
}
</script>

<template>
  <div class="page">
    <StateBlock
      :loading="settings.loading.value"
      :error="settings.error.value"
      loading-text="Loading settings…"
      @retry="settings.reload()"
    >
      <template v-if="current">
        <section class="card">
          <h2>Sync backoff</h2>
          <p v-if="current.syncBackoffUntil === null" class="muted">
            Not backed off. Syncing runs on its normal schedule.
          </p>
          <p v-else class="muted">
            Paused until {{ formatDateTime(current.syncBackoffUntil, current.timezone) }} ({{
              relativeTime(current.syncBackoffUntil)
            }}) after an upstream asked us to slow down. It clears itself; there is nothing to
            press.
          </p>
        </section>

        <section class="card">
          <div class="row">
            <h2>MCP</h2>
            <label class="toggle spacer">
              <input
                type="checkbox"
                :checked="current.mcpEnabled"
                :disabled="toggleMcp.busy.value"
                @change="onToggleMcp(($event.target as HTMLInputElement).checked)"
              />
              {{ current.mcpEnabled ? "enabled" : "disabled" }}
            </label>
          </div>
          <p class="muted">
            Clients, policy rules and the audit log live on the
            <RouterLink to="/mcp">MCP</RouterLink> page.
          </p>
        </section>

        <section class="card">
          <h2>Current configuration</h2>
          <p class="muted">
            Edited on <RouterLink to="/calendar">Calendar</RouterLink>, where each value sits next
            to what it affects.
          </p>
          <div class="table-wrap">
            <table>
              <tbody>
                <tr>
                  <th>Timezone</th>
                  <td>{{ current.timezone ?? "not set" }}</td>
                </tr>
                <tr>
                  <th>Calendar</th>
                  <td>{{ current.calendarId }}</td>
                </tr>
                <tr>
                  <th>Default title template</th>
                  <td>
                    <code>{{ current.defaultTitleTemplate }}</code>
                  </td>
                </tr>
                <tr>
                  <th>Default colour</th>
                  <td>{{ current.defaultColorId ?? "calendar default" }}</td>
                </tr>
                <tr>
                  <th>Ghost colour</th>
                  <td>{{ current.ghostColorId }}</td>
                </tr>
                <tr>
                  <th>Default arrive-early</th>
                  <td>{{ current.defaultArrivalOffsetMin }} min</td>
                </tr>
                <tr>
                  <th>Past window</th>
                  <td>{{ current.windowPastDays }} days</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="card">
          <h2>Admin password</h2>
          <p class="muted">
            There is no password field here on purpose: the hash is a Worker secret, not a row in
            the database. Rotate it from a checkout with
          </p>
          <pre>npm run set-password</pre>
          <p class="muted">
            which prints a new password once and stores its hash. Signing out everywhere is a
            consequence of rotating the session secret, not of this.
          </p>
        </section>

        <section class="card">
          <h2>Public pages</h2>
          <p class="muted">
            Served by the Worker outside the login gate, because the OAuth registrations point at
            them.
          </p>
          <div class="row">
            <a class="btn small" href="/about">About</a>
            <a class="btn small" href="/privacy">Privacy</a>
            <a class="btn small" href="/terms">Terms</a>
          </div>
        </section>
      </template>
    </StateBlock>
  </div>
</template>

<style scoped>
h2 {
  font-size: 1.05rem;
}

.toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.9rem;
}

th {
  width: 40%;
  padding-right: 12px;
}
</style>
