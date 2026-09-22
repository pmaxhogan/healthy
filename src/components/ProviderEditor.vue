<script setup lang="ts">
// One provider's configuration and the operations that can be run against it.
//
// The editor holds a draft and saves on demand rather than on every keystroke:
// a title template is half-invalid while it is being typed, and a PATCH per
// character would sync nonsense.

import { computed, reactive, ref, watch } from "vue";

import { endpoints } from "../api/endpoints.ts";
import { humanizeCode, relativeTime } from "../lib/format.ts";
import { reconnectHref } from "../lib/oauth.ts";
import { DEFAULT_TITLE_TEMPLATE } from "../lib/template.ts";
import { toastSuccess } from "../lib/toasts.ts";
import { useAction } from "../lib/use-load.ts";

import ArrivalOffsetsField from "./ArrivalOffsetsField.vue";
import ColorSwatches from "./ColorSwatches.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import PortalAccountCard from "./PortalAccountCard.vue";
import StatusPill from "./StatusPill.vue";
import TitleTemplateField from "./TitleTemplateField.vue";

import type { ColorOptionDto, ProviderDto, SettingsDto } from "@shared/types.ts";

const props = defineProps<{
  provider: ProviderDto;
  colors: ColorOptionDto[];
  settings: SettingsDto;
}>();

const emit = defineEmits<{ changed: []; removed: [] }>();

interface Draft {
  displayName: string;
  orgShort: string;
  portalUrl: string;
  titleTemplate: string;
  colorId: string | null;
  arrivalOffsetMin: number | null;
  arrivalOffsets: Record<string, number>;
  enabled: boolean;
}

function draftFrom(provider: ProviderDto): Draft {
  return {
    displayName: provider.displayName,
    orgShort: provider.config.orgShort ?? "",
    portalUrl: provider.portalUrl ?? "",
    titleTemplate: provider.config.titleTemplate ?? "",
    colorId: provider.config.colorId ?? null,
    arrivalOffsetMin: provider.config.arrivalOffsetMin ?? null,
    arrivalOffsets: { ...provider.config.arrivalOffsetsByVisitType },
    enabled: provider.config.enabled !== false,
  };
}

const draft = reactive<Draft>(draftFrom(props.provider));
const secret = ref("");
const showSecret = ref(false);
const confirming = ref(false);

const save = useAction();
const secretAction = useAction();
const operation = useAction();
const removal = useAction();

// A reload elsewhere on the page (a sync finished, say) brings a fresh DTO; an
// untouched editor should follow it rather than sit on a stale copy.
watch(
  () => props.provider,
  (next) => {
    if (!save.busy.value) Object.assign(draft, draftFrom(next));
  },
);

const status = computed(() => props.provider.connection?.status ?? "disconnected");
const href = computed(() => reconnectHref(props.provider));
const effectiveTemplate = computed(() =>
  draft.titleTemplate === ""
    ? props.settings.defaultTitleTemplate || DEFAULT_TITLE_TEMPLATE
    : draft.titleTemplate,
);

async function onSave(): Promise<void> {
  const template = draft.titleTemplate.trim();
  const orgShort = draft.orgShort.trim();
  const portal = draft.portalUrl.trim();
  const ok = await save.run(async () => {
    await endpoints.updateProvider(props.provider.id, {
      displayName: draft.displayName.trim(),
      portalUrl: portal === "" ? null : portal,
      // The config is replaced wholesale, and every optional field is rejected
      // when empty (the Worker's schema is strict and its strings are min(1)).
      // So "inherit the default" is expressed by leaving the key out entirely --
      // which is also what makes a cleared field clear rather than save "".
      config: {
        arrivalOffsetsByVisitType: draft.arrivalOffsets,
        enabled: draft.enabled,
        ...(template !== "" && { titleTemplate: template }),
        ...(orgShort !== "" && { orgShort }),
        ...(draft.colorId !== null && { colorId: draft.colorId }),
        ...(draft.arrivalOffsetMin !== null && { arrivalOffsetMin: draft.arrivalOffsetMin }),
      },
    });
    toastSuccess("Saved.");
  });
  if (ok) emit("changed");
}

async function onSetSecret(): Promise<void> {
  const value = secret.value;
  if (value === "") return;
  const ok = await secretAction.run(async () => {
    await endpoints.setProviderSecret(props.provider.id, value);
    toastSuccess("Client secret stored.");
  });
  if (!ok) {
    return;
  }

  secret.value = "";
  showSecret.value = false;
  emit("changed");
}

async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
  const ok = await operation.run(async () => {
    await fn();
    toastSuccess(label);
  });
  if (ok) emit("changed");
}

async function onRemove(): Promise<void> {
  const ok = await removal.run(async () => {
    await endpoints.deleteProvider(props.provider.id);
    toastSuccess("Provider removed.");
  });
  confirming.value = false;
  if (ok) emit("removed");
}
</script>

<template>
  <section class="card">
    <div class="row">
      <h3>{{ provider.displayName }}</h3>
      <span v-if="provider.environment === 'sandbox'" class="chip">sandbox</span>
      <StatusPill :status="status" />
      <span v-if="provider.connection?.lastErrorCode" class="chip danger-text">
        {{ humanizeCode(provider.connection.lastErrorCode) }}
      </span>
    </div>

    <p class="muted">
      Last sync {{ relativeTime(provider.connection?.lastSyncAt) }} · token
      {{ relativeTime(provider.connection?.accessExpiresAt) }} ·
      {{ provider.hasClientSecret ? "secret set" : "no client secret" }}
    </p>

    <div class="fields two">
      <label class="field">
        Display name
        <input v-model="draft.displayName" autocomplete="off" />
      </label>
      <label class="field">
        Short label — <code>{orgShort}</code>
        <input v-model="draft.orgShort" autocomplete="off" />
      </label>
      <label class="field">
        Patient portal URL
        <input v-model="draft.portalUrl" type="url" autocomplete="off" placeholder="optional" />
      </label>
      <label class="field check">
        <span>Sync</span>
        <span class="toggle">
          <input v-model="draft.enabled" type="checkbox" />
          {{ draft.enabled ? "on" : "off" }}
        </span>
      </label>
    </div>

    <TitleTemplateField
      v-model="draft.titleTemplate"
      :placeholder="effectiveTemplate"
      label="Title template (blank uses the default)"
    />

    <div class="field">
      Event colour
      <ColorSwatches v-model="draft.colorId" :colors="colors" default-label="Use the default" />
    </div>

    <ArrivalOffsetsField
      v-model="draft.arrivalOffsetMin"
      :overrides="draft.arrivalOffsets"
      :inherited-default="settings.defaultArrivalOffsetMin"
      @update:overrides="draft.arrivalOffsets = $event"
    />

    <div class="row">
      <button class="primary" :disabled="save.busy.value" @click="onSave">
        {{ save.busy.value ? "Saving…" : "Save" }}
      </button>
      <a class="btn small" :href="href">{{
        status === "disconnected" ? "Connect" : "Reconnect"
      }}</a>
      <button
        class="small"
        :disabled="operation.busy.value"
        @click="run('Sync started.', () => endpoints.syncProvider(provider.id))"
      >
        Sync now
      </button>
      <button
        class="small"
        :disabled="operation.busy.value"
        @click="run('Token refreshed.', () => endpoints.refreshProviderToken(provider.id))"
      >
        Refresh token
      </button>
      <button
        class="small"
        :disabled="operation.busy.value"
        @click="run('Full refresh started.', () => endpoints.fullRefreshProvider(provider.id))"
      >
        Full refresh
      </button>
      <button class="small" @click="showSecret = !showSecret">
        {{ provider.hasClientSecret ? "Replace secret" : "Set secret" }}
      </button>
      <button class="small danger spacer" @click="confirming = true">Remove</button>
    </div>

    <div v-if="showSecret" class="row secret">
      <input
        v-model="secret"
        type="password"
        class="grow"
        autocomplete="new-password"
        placeholder="Client secret (write-only)"
        aria-label="Client secret"
      />
      <button
        class="primary small"
        :disabled="secret === '' || secretAction.busy.value"
        @click="onSetSecret"
      >
        Store
      </button>
    </div>

    <PortalAccountCard :provider-id="provider.id" :portal-url="provider.portalUrl" />

    <ConfirmDialog
      v-if="confirming"
      :title="`Remove ${provider.displayName}?`"
      body="The local connection and its cached data go away. Calendar events already written are left alone."
      :require-text="provider.displayName"
      :busy="removal.busy.value"
      @cancel="confirming = false"
      @confirm="onRemove"
    />
  </section>
</template>

<style scoped>
h3 {
  font-size: 1rem;
}

.check {
  align-self: end;
}

.toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
  font-size: 1rem;
  height: 38px;
}

.grow {
  flex: 1;
  min-width: 160px;
}

.secret {
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
</style>
