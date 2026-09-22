<script setup lang="ts">
// Everything about the Google side: which account, which calendar, and the
// defaults every provider inherits when it has no override of its own.

import { computed, reactive, ref, watch } from "vue";

import { endpoints } from "../api/endpoints.ts";
import ColorSwatches from "../components/ColorSwatches.vue";
import StateBlock from "../components/StateBlock.vue";
import StatusPill from "../components/StatusPill.vue";
import TimezoneSelect from "../components/TimezoneSelect.vue";
import TitleTemplateField from "../components/TitleTemplateField.vue";
import { formatDateTime, maskAccount, relativeTime } from "../lib/format.ts";
import { GOOGLE_START } from "../lib/oauth.ts";
import { toastSuccess } from "../lib/toasts.ts";
import { useAction, useLoad } from "../lib/use-load.ts";

import type { SettingsDto } from "@shared/types.ts";

const google = useLoad((signal) => endpoints.google(signal));
const settings = useLoad((signal) => endpoints.settings(signal));
const calendars = useLoad(async (signal) => {
  try {
    return await endpoints.googleCalendars(signal);
  } catch {
    // No Google connection yet, or the list failed: the picker degrades to the
    // id already in settings rather than taking the page down with it.
    return [];
  }
});
const colors = useLoad(async (signal) => {
  try {
    return await endpoints.googleColors(signal);
  } catch {
    return [];
  }
});

const save = useAction();
const disconnect = useAction();
const disconnecting = ref(false);

interface Draft {
  calendarId: string;
  timezone: string | null;
  defaultTitleTemplate: string;
  defaultColorId: string | null;
  ghostColorId: string;
  defaultArrivalOffsetMin: number;
  windowPastDays: number;
}

function draftFrom(value: SettingsDto): Draft {
  return {
    calendarId: value.calendarId,
    timezone: value.timezone,
    defaultTitleTemplate: value.defaultTitleTemplate,
    defaultColorId: value.defaultColorId,
    ghostColorId: value.ghostColorId,
    defaultArrivalOffsetMin: value.defaultArrivalOffsetMin,
    windowPastDays: value.windowPastDays,
  };
}

const draft = reactive<Draft>({
  calendarId: "primary",
  timezone: null,
  defaultTitleTemplate: "",
  defaultColorId: null,
  ghostColorId: "8",
  defaultArrivalOffsetMin: 0,
  windowPastDays: 90,
});

watch(settings.data, (value) => {
  if (value) Object.assign(draft, draftFrom(value));
});

const connected = computed(() => google.data.value?.status === "connected");
const backoffUntil = computed(() => settings.data.value?.syncBackoffUntil ?? null);

/** The picker offers whatever the account owns, plus whatever is already saved. */
const calendarOptions = computed(() => {
  const list = calendars.data.value ?? [];
  if (list.some((c) => c.id === draft.calendarId)) return list;
  return [
    {
      id: draft.calendarId,
      summary: draft.calendarId,
      primary: false,
      timeZone: null,
      backgroundColor: null,
    },
    ...list,
  ];
});

async function onSave(): Promise<void> {
  // `defaultTitleTemplate` has no "unset" state on the Worker side -- the schema
  // requires at least one character -- so a blank box leaves the stored value
  // alone rather than being rejected as a 400.
  const template = draft.defaultTitleTemplate.trim();
  const ok = await save.run(async () => {
    const saved = await endpoints.saveSettings({
      calendarId: draft.calendarId,
      timezone: draft.timezone,
      defaultColorId: draft.defaultColorId,
      ghostColorId: draft.ghostColorId,
      defaultArrivalOffsetMin: draft.defaultArrivalOffsetMin,
      windowPastDays: draft.windowPastDays,
      ...(template !== "" && { defaultTitleTemplate: template }),
    });
    settings.set(saved);
    toastSuccess("Calendar settings saved.");
  });
  if (!ok) await settings.reload();
}

async function onDisconnect(): Promise<void> {
  const ok = await disconnect.run(async () => {
    await endpoints.disconnectGoogle();
    toastSuccess("Google disconnected. Events already written are left alone.");
  });
  disconnecting.value = false;
  if (ok) await google.reload();
}
</script>

<template>
  <div class="page">
    <section class="card">
      <div class="row">
        <h2>Google account</h2>
        <StatusPill :status="google.data.value?.status ?? 'not_connected'" />
      </div>

      <StateBlock
        :loading="google.loading.value"
        :error="google.error.value"
        loading-text="Checking the Google connection…"
        @retry="google.reload()"
      >
        <template v-if="google.data.value">
          <dl class="facts">
            <div>
              <dt>Account</dt>
              <dd>{{ maskAccount(google.data.value.accountLabel) }}</dd>
            </div>
            <div>
              <dt>Connected</dt>
              <dd>{{ relativeTime(google.data.value.connectedAt) }}</dd>
            </div>
            <div>
              <dt>Token</dt>
              <dd>{{ relativeTime(google.data.value.accessExpiresAt) }}</dd>
            </div>
            <div v-if="google.data.value.needsReauthSince">
              <dt>Needs re-auth since</dt>
              <dd class="danger-text">{{ relativeTime(google.data.value.needsReauthSince) }}</dd>
            </div>
          </dl>
          <div class="row">
            <a class="btn" :class="{ primary: !connected }" :href="GOOGLE_START">
              {{ connected ? "Reconnect" : "Connect Google" }}
            </a>
            <button v-if="connected" class="small danger spacer" @click="disconnecting = true">
              Disconnect
            </button>
          </div>
          <p v-if="disconnecting" class="muted">
            Disconnecting stops all syncing and forgets the tokens.
            <button class="small danger" :disabled="disconnect.busy.value" @click="onDisconnect">
              Confirm
            </button>
            <button class="small" @click="disconnecting = false">Cancel</button>
          </p>
        </template>
      </StateBlock>
    </section>

    <section v-if="backoffUntil" class="card backoff">
      <h2>Syncing is backed off</h2>
      <p class="muted">
        An upstream asked us to slow down. The next attempt is
        {{ relativeTime(backoffUntil) }} ({{ formatDateTime(backoffUntil, draft.timezone) }}).
      </p>
    </section>

    <section class="card">
      <h2>Calendar and defaults</h2>

      <StateBlock
        :loading="settings.loading.value"
        :error="settings.error.value"
        loading-text="Loading settings…"
        @retry="settings.reload()"
      >
        <div class="fields">
          <label class="field">
            Target calendar
            <select v-model="draft.calendarId">
              <option v-for="option in calendarOptions" :key="option.id" :value="option.id">
                {{ option.summary }}{{ option.primary ? " (primary)" : "" }}
              </option>
            </select>
            <span v-if="calendars.loading.value" class="muted">Loading calendars…</span>
            <span v-else-if="(calendars.data.value ?? []).length === 0" class="muted">
              Connect Google to choose from your calendars.
            </span>
          </label>

          <TimezoneSelect
            :model-value="draft.timezone"
            @update:model-value="draft.timezone = $event"
          />

          <TitleTemplateField v-model="draft.defaultTitleTemplate" label="Default title template" />

          <div class="field">
            Default event colour
            <ColorSwatches
              v-model="draft.defaultColorId"
              :colors="colors.data.value ?? []"
              default-label="Calendar default"
            />
          </div>

          <div class="field">
            Cancelled (ghost) event colour
            <ColorSwatches
              :model-value="draft.ghostColorId"
              :colors="colors.data.value ?? []"
              :allow-default="false"
              @update:model-value="draft.ghostColorId = $event ?? draft.ghostColorId"
            />
            <span class="muted">Ghosts are never deleted, only recoloured and marked free.</span>
          </div>

          <div class="fields two">
            <label class="field">
              Default arrive-early (minutes)
              <input
                v-model.number="draft.defaultArrivalOffsetMin"
                type="number"
                min="0"
                max="240"
              />
            </label>
            <label class="field">
              Keep past appointments for (days)
              <input v-model.number="draft.windowPastDays" type="number" min="0" max="730" />
            </label>
          </div>
        </div>

        <div class="row">
          <button class="primary" :disabled="save.busy.value" @click="onSave">
            {{ save.busy.value ? "Saving…" : "Save" }}
          </button>
        </div>
      </StateBlock>
    </section>
  </div>
</template>

<style scoped>
h2 {
  font-size: 1.05rem;
}

.backoff {
  border-color: color-mix(in srgb, var(--warn) 45%, var(--border));
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
