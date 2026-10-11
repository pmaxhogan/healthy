<script setup lang="ts">
// One health system's configuration and the operations that can be run against it.
//
// The editor holds a draft and saves on demand rather than on every keystroke:
// a title template is half-invalid while it is being typed, and a PATCH per
// character would sync nonsense.
//
// The vendor and FHIR base are editable only while the health system has no live
// connection: a connected one's cache and tokens belong to the old endpoint, and
// the Worker refuses the change with a 409. The editor mirrors that rule rather
// than offering a field that can only fail.

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

import type { ColorOptionDto, HealthSystemDto, SettingsDto, Vendor } from "@shared/types.ts";

const props = defineProps<{
  healthSystem: HealthSystemDto;
  colors: ColorOptionDto[];
  settings: SettingsDto;
}>();

const emit = defineEmits<{ changed: []; removed: [] }>();

interface Draft {
  displayName: string;
  orgShort: string;
  epicOrgId: string;
  vendor: Vendor;
  fhirBaseUrl: string;
  portalUrl: string;
  titleTemplate: string;
  colorId: string | null;
  arrivalOffsetMin: number | null;
  arrivalOffsets: Record<string, number>;
  enabled: boolean;
}

function draftFrom(healthSystem: HealthSystemDto): Draft {
  return {
    displayName: healthSystem.displayName,
    orgShort: healthSystem.config.orgShort ?? "",
    epicOrgId: healthSystem.config.epicOrgId ?? "",
    vendor: healthSystem.vendor,
    fhirBaseUrl: healthSystem.fhirBaseUrl,
    portalUrl: healthSystem.portalUrl ?? "",
    titleTemplate: healthSystem.config.titleTemplate ?? "",
    colorId: healthSystem.config.colorId ?? null,
    arrivalOffsetMin: healthSystem.config.arrivalOffsetMin ?? null,
    arrivalOffsets: { ...healthSystem.config.arrivalOffsetsByVisitType },
    enabled: healthSystem.config.enabled !== false,
  };
}

const draft = reactive<Draft>(draftFrom(props.healthSystem));
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
  () => props.healthSystem,
  (next) => {
    if (!save.busy.value) Object.assign(draft, draftFrom(next));
  },
);

const status = computed(() => props.healthSystem.connection?.status ?? "disconnected");
const endpointEditable = computed(
  () =>
    props.healthSystem.connection === null ||
    props.healthSystem.connection.status === "disconnected",
);
// The draft's vendor, so the Epic-only field disappears as soon as ModMed is picked.
const isModmed = computed(() => draft.vendor === "modmed");
const href = computed(() => reconnectHref(props.healthSystem));
const vendorLabel = computed(() => (props.healthSystem.vendor === "modmed" ? "ModMed" : "Epic"));
const secretLabel = computed(
  () =>
    ({ stored: "secret set", derived: "secret derived", none: "no client secret" })[
      props.healthSystem.clientSecretSource
    ],
);
const effectiveTemplate = computed(() =>
  draft.titleTemplate === ""
    ? props.settings.defaultTitleTemplate || DEFAULT_TITLE_TEMPLATE
    : draft.titleTemplate,
);

async function onSave(): Promise<void> {
  const template = draft.titleTemplate.trim();
  const orgShort = draft.orgShort.trim();
  const epicOrgId = draft.epicOrgId.trim();
  const portal = draft.portalUrl.trim();
  const fhirBaseUrl = draft.fhirBaseUrl.trim();
  const ok = await save.run(async () => {
    await endpoints.updateHealthSystem(props.healthSystem.id, {
      // Only a changed endpoint field is sent: the Worker re-runs SMART discovery
      // for it, and rejects it outright once the health system is connected.
      ...(endpointEditable.value &&
        draft.vendor !== props.healthSystem.vendor && { vendor: draft.vendor }),
      ...(endpointEditable.value &&
        fhirBaseUrl !== props.healthSystem.fhirBaseUrl && { fhirBaseUrl }),
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
        ...(epicOrgId !== "" && !isModmed.value && { epicOrgId }),
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
    await endpoints.setHealthSystemSecret(props.healthSystem.id, value);
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
    await endpoints.deleteHealthSystem(props.healthSystem.id);
    toastSuccess("Health system removed.");
  });
  confirming.value = false;
  if (ok) emit("removed");
}
</script>

<template>
  <section class="card">
    <div class="row">
      <h3>{{ healthSystem.displayName }}</h3>
      <span v-if="healthSystem.environment === 'sandbox'" class="chip">sandbox</span>
      <StatusPill :status="status" />
      <span v-if="!healthSystem.hasClientSecret" class="chip danger" role="alert">
        No {{ healthSystem.environment === "sandbox" ? "sandbox" : "production" }} client secret —
        Connect will fail until one is set
      </span>
      <span v-if="healthSystem.connection?.lastErrorCode" class="chip danger-text">
        {{ humanizeCode(healthSystem.connection.lastErrorCode) }}
      </span>
    </div>

    <p class="muted">
      Last sync {{ relativeTime(healthSystem.connection?.lastSyncAt) }} · token
      {{ relativeTime(healthSystem.connection?.accessExpiresAt) }} ·
      {{ secretLabel }}
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
      <label v-if="!isModmed" class="field">
        Epic organisation id
        <input
          v-model="draft.epicOrgId"
          autocomplete="off"
          inputmode="numeric"
          placeholder="optional — derives the client secret"
        />
      </label>
      <label class="field">
        Patient portal URL
        <input v-model="draft.portalUrl" type="url" autocomplete="off" placeholder="optional" />
      </label>
      <label class="field">
        Vendor
        <select v-if="endpointEditable" v-model="draft.vendor" name="vendor">
          <option value="epic">Epic</option>
          <option value="modmed">ModMed</option>
        </select>
        <input v-else :value="vendorLabel" readonly name="vendor" />
      </label>
      <label class="field">
        FHIR base URL
        <input
          v-model="draft.fhirBaseUrl"
          type="url"
          autocomplete="off"
          name="fhirBaseUrl"
          :readonly="!endpointEditable"
        />
      </label>
      <label class="field check">
        <span>Sync</span>
        <span class="toggle">
          <input v-model="draft.enabled" type="checkbox" />
          {{ draft.enabled ? "on" : "off" }}
        </span>
      </label>
    </div>

    <p v-if="!endpointEditable" class="muted">
      Disconnect this health system before changing its vendor or FHIR base URL.
    </p>
    <p v-else-if="isModmed" class="muted">
      Use the practice's own FHIR base URL: a generic ModMed base passes the check but then rejects
      every patient sign-in.
    </p>

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
        @click="run('Sync started.', () => endpoints.syncHealthSystem(healthSystem.id))"
      >
        Sync now
      </button>
      <button
        class="small"
        :disabled="operation.busy.value"
        @click="run('Token refreshed.', () => endpoints.refreshHealthSystemToken(healthSystem.id))"
      >
        Refresh token
      </button>
      <button
        class="small"
        :disabled="operation.busy.value"
        @click="
          run('Full refresh started.', () => endpoints.fullRefreshHealthSystem(healthSystem.id))
        "
      >
        Full refresh
      </button>
      <button class="small" @click="showSecret = !showSecret">
        {{ healthSystem.clientSecretSource === "stored" ? "Replace secret" : "Set secret" }}
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

    <PortalAccountCard :health-system-id="healthSystem.id" :portal-url="healthSystem.portalUrl" />

    <ConfirmDialog
      v-if="confirming"
      :title="`Remove ${healthSystem.displayName}?`"
      body="The local connection and its cached data go away. Calendar events already written are left alone."
      :require-text="healthSystem.displayName"
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
