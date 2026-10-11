<script setup lang="ts">
// One paired phone: its status, what it last reported, and the actions on it.
//
// Rotating hands the new token up to the page (`paired`), which owns the one-time
// pairing panel; this card never holds a token. Revoke, rotate and wipe each ask
// first, and wipe makes the owner type the phone's name, because it deletes the
// phone's whole stored history and cannot be undone.

import { computed, ref } from "vue";

import { endpoints } from "../api/endpoints.ts";
import { formatBytes, formatDateTime, relativeTime } from "../lib/format.ts";
import { toastSuccess } from "../lib/toasts.ts";
import { useAction } from "../lib/use-load.ts";

import ConfirmDialog from "./ConfirmDialog.vue";
import DeviceDetails from "./DeviceDetails.vue";
import PhoneStatusPill from "./PhoneStatusPill.vue";

import type { DeviceDto, PairedDeviceDto } from "@shared/types.ts";

const props = defineProps<{ device: DeviceDto; timezone: string | null }>();

const emit = defineEmits<{ changed: []; paired: [paired: PairedDeviceDto] }>();

/** Wipe calls before the card stops and says so. A phone's history is many slices, not thousands. */
const MAX_WIPE_CALLS = 1000;

type Pending = "rotate" | "revoke" | "wipe" | null;
const pending = ref<Pending>(null);
const showDetails = ref(false);
const renaming = ref(false);
const nameDraft = ref("");

const rename = useAction();
const rotate = useAction();
const revoke = useAction();
const wipe = useAction();
const retry = useAction();

const revoked = computed(() => props.device.status === "revoked");
const nameValid = computed(() => nameDraft.value.trim() !== "");
const queueText = computed(() => {
  const { batches, bytes } = props.device.queue;
  if (batches === 0) return "empty";
  return `${String(batches)} batch${batches === 1 ? "" : "es"} · ${formatBytes(bytes)}`;
});

function startRename(): void {
  nameDraft.value = props.device.name;
  renaming.value = true;
}

async function saveName(): Promise<void> {
  if (!nameValid.value) return;
  const ok = await rename.run(async () => {
    await endpoints.renameDevice(props.device.id, nameDraft.value.trim());
    toastSuccess("Phone renamed.");
  });
  if (!ok) {
    return;
  }

  renaming.value = false;
  emit("changed");
}

async function doRotate(): Promise<void> {
  await rotate.run(async () => {
    emit("paired", await endpoints.rotateDevice(props.device.id));
  });
  pending.value = null;
  emit("changed");
}

async function doRevoke(): Promise<void> {
  const ok = await revoke.run(async () => {
    await endpoints.revokeDevice(props.device.id);
    toastSuccess("Phone revoked. It can no longer upload.");
  });
  pending.value = null;
  if (ok) emit("changed");
}

async function doWipe(): Promise<void> {
  await wipe.run(async () => {
    // The Worker deletes a bounded amount per call and says when it is finished.
    for (let call = 0; call < MAX_WIPE_CALLS; call++) {
      const { done } = await endpoints.wipeDevice(props.device.id, { confirm: props.device.id });
      if (done) {
        toastSuccess("The phone and its stored data were deleted.");
        return;
      }
    }
    throw new Error("wipe did not finish");
  });
  pending.value = null;
  // Reload whether or not it finished: a partial wipe changes the totals.
  emit("changed");
}

function noun(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

async function doRetry(): Promise<void> {
  const ok = await retry.run(async () => {
    const { requeued, remarked } = await endpoints.retryFailedUploads(props.device.id);
    const parts = [
      requeued > 0 ? `${String(requeued)} ${noun("upload", requeued)}` : "",
      remarked > 0 ? `${String(remarked)} ${noun("rebuild", remarked)}` : "",
    ].filter(Boolean);
    toastSuccess(
      parts.length === 0
        ? "Nothing was waiting to retry."
        : `${parts.join(" and ")} put back in the queue.`,
    );
  });
  if (ok) emit("changed");
}

function yesNo(value: boolean | null): string {
  if (value === null) return "—";
  return value ? "yes" : "no";
}
</script>

<template>
  <article class="card">
    <div class="head">
      <h3 class="name" :title="device.name">{{ device.name }}</h3>
      <PhoneStatusPill :status="device.status" />
      <span v-if="device.appVersion" class="chip">v{{ device.appVersion }}</span>
    </div>

    <div v-if="device.parked.batches > 0 || device.parkedMarks > 0" class="parked" role="alert">
      <p v-if="device.parked.batches > 0">
        <strong>
          {{ device.parked.batches }} upload{{ device.parked.batches === 1 ? "" : "s" }} could not
          be applied and {{ device.parked.batches === 1 ? "is" : "are" }} being kept
        </strong>
        ({{ formatBytes(device.parked.bytes) }}). The phone has already moved past
        {{ device.parked.batches === 1 ? "it" : "them" }}, so nothing is deleted.
        <template v-if="device.parked.errorCodes.length > 0">
          Error: <code>{{ device.parked.errorCodes.join(", ") }}</code>
        </template>
      </p>
      <p v-if="device.parkedMarks > 0">
        <strong>
          {{ device.parkedMarks }} summary rebuild{{ device.parkedMarks === 1 ? "" : "s" }} could
          not run and {{ device.parkedMarks === 1 ? "is" : "are" }} being kept.
        </strong>
        Daily totals, sleep or exercise summaries may be missing until they are retried.
      </p>
      <button type="button" class="small" :disabled="retry.busy.value" @click="doRetry">
        {{ retry.busy.value ? "Retrying…" : "Retry" }}
      </button>
    </div>

    <form v-if="renaming" class="row" @submit.prevent="saveName">
      <label class="field grow">
        Name
        <input
          v-model="nameDraft"
          maxlength="60"
          autocomplete="off"
          :disabled="rename.busy.value"
        />
      </label>
      <button type="submit" class="primary" :disabled="!nameValid || rename.busy.value">
        {{ rename.busy.value ? "Saving…" : "Save" }}
      </button>
      <button type="button" :disabled="rename.busy.value" @click="renaming = false">Cancel</button>
    </form>

    <dl class="facts">
      <div>
        <dt>Last upload</dt>
        <dd :title="formatDateTime(device.lastUploadAt, timezone)">
          {{ device.lastUploadAt ? relativeTime(device.lastUploadAt) : "never" }}
        </dd>
      </div>
      <div>
        <dt>Last seen</dt>
        <dd :title="formatDateTime(device.lastSeenAt, timezone)">
          {{ device.lastSeenAt ? relativeTime(device.lastSeenAt) : "never" }}
        </dd>
      </div>
      <div>
        <dt>Records</dt>
        <dd>{{ device.totals.recordCount.toLocaleString() }}</dd>
      </div>
      <div>
        <dt>Types</dt>
        <dd>
          {{ device.totals.typesGranted }} granted<template v-if="device.totals.typesDenied > 0"
            >, <span class="danger-text">{{ device.totals.typesDenied }} denied</span></template
          >
        </dd>
      </div>
      <div>
        <dt>Waiting to apply</dt>
        <dd>{{ queueText }}</dd>
      </div>
      <div>
        <dt>Paired</dt>
        <dd :title="formatDateTime(device.createdAt, timezone)">
          {{ relativeTime(device.createdAt) }}
          <template v-if="device.rotatedAt">
            · token rotated {{ relativeTime(device.rotatedAt) }}
          </template>
          <template v-if="device.revokedAt">
            · revoked {{ relativeTime(device.revokedAt) }}
          </template>
        </dd>
      </div>
    </dl>

    <dl v-if="device.report" class="facts" aria-label="What the phone last reported">
      <div>
        <dt>Battery exemption</dt>
        <dd :class="{ 'danger-text': device.report.batteryExempt === false }">
          {{ yesNo(device.report.batteryExempt) }}
        </dd>
      </div>
      <div>
        <dt>Background read</dt>
        <dd :class="{ 'danger-text': device.report.backgroundRead === false }">
          {{ yesNo(device.report.backgroundRead) }}
        </dd>
      </div>
      <div v-if="device.report.exerciseRoutes">
        <dt>Exercise routes</dt>
        <dd :class="{ 'danger-text': device.report.exerciseRoutes !== 'granted' }">
          {{ device.report.exerciseRoutes }}
        </dd>
      </div>
      <div>
        <dt>History read</dt>
        <dd>{{ yesNo(device.report.historyRead) }}</dd>
      </div>
      <div>
        <dt>Backfill complete</dt>
        <dd>{{ yesNo(device.report.backfillComplete) }}</dd>
      </div>
      <div v-if="device.report.lastErrorCode">
        <dt>Last error</dt>
        <dd class="danger-text">
          {{ device.report.lastErrorCode }}
          <template v-if="device.report.lastErrorAt">
            · {{ relativeTime(device.report.lastErrorAt) }}
          </template>
        </dd>
      </div>
    </dl>

    <div class="row">
      <button
        type="button"
        class="small"
        :aria-expanded="showDetails"
        @click="showDetails = !showDetails"
      >
        {{ showDetails ? "Hide details" : "Show details" }}
      </button>
      <button type="button" class="small" :disabled="renaming" @click="startRename">Rename</button>
      <button type="button" class="small" :disabled="revoked" @click="pending = 'rotate'">
        Rotate token
      </button>
      <button type="button" class="small danger" :disabled="revoked" @click="pending = 'revoke'">
        Revoke
      </button>
      <button type="button" class="small danger spacer" @click="pending = 'wipe'">
        Delete phone and data
      </button>
    </div>

    <DeviceDetails v-if="showDetails" :device-id="device.id" :timezone="timezone" />

    <ConfirmDialog
      v-if="pending === 'rotate'"
      title="Rotate this phone's token?"
      body="The old token stops working immediately. The phone will not sync again until you pair it with the new code."
      confirm-label="Rotate"
      :busy="rotate.busy.value"
      @confirm="doRotate"
      @cancel="pending = null"
    />
    <ConfirmDialog
      v-if="pending === 'revoke'"
      title="Revoke this phone?"
      body="Its token stops working and it can no longer upload. What it already sent is kept. To use the phone again, pair it as a new device."
      confirm-label="Revoke"
      :busy="revoke.busy.value"
      @confirm="doRevoke"
      @cancel="pending = null"
    />
    <ConfirmDialog
      v-if="pending === 'wipe'"
      title="Delete this phone and all its data?"
      body="Every Health Connect record stored from this phone, and the phone itself, is permanently deleted. This cannot be undone."
      confirm-label="Delete everything"
      :require-text="device.name"
      :busy="wipe.busy.value"
      @confirm="doWipe"
      @cancel="pending = null"
    />
  </article>
</template>

<style scoped>
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.name {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.parked {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  align-items: center;
  padding: 8px 10px;
  border: 1px solid var(--warn);
  border-radius: 8px;
  color: var(--warn);
  font-size: 0.9rem;
}

.parked p {
  margin: 0;
  flex: 1 1 16rem;
  min-width: 0;
  overflow-wrap: anywhere;
}

.grow {
  flex: 1;
}

.facts {
  margin: 0;
  display: grid;
  gap: 6px 16px;
  grid-template-columns: 1fr;
  font-size: 0.88rem;
}

@media (min-width: 640px) {
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
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
