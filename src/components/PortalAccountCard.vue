<script setup lang="ts">
// The MyChart portal login for one provider: save it, start a sign-in, watch it
// through the emailed-code round trip, sync on demand, or tear it down.
//
// Embedded inside ProviderEditor rather than owning its own page: the portal
// login is a property of the provider, exactly like the FHIR client secret a
// few rows up, and it is write-only for the same reason -- this is a sealed-in-D1
// credential, not something the UI should ever read back. Only the password
// field is literally write-only, though: the username is not secret on its
// own, so unlike the password the field is free to be re-typed on every save
// without pretending a stored one does not exist.

import { computed, reactive, ref, watch } from "vue";

import { codeMessage } from "../api/client.ts";
import { endpoints, isPortalSignInInProgress } from "../api/endpoints.ts";
import { relativeTime } from "../lib/format.ts";
import { toastSuccess } from "../lib/toasts.ts";
import { useAction } from "../lib/use-load.ts";
import { effectiveSignIn, usePortalAccount } from "../lib/use-portal-account.ts";

import ConfirmDialog from "./ConfirmDialog.vue";
import StateBlock from "./StateBlock.vue";

import type { PortalDiscoveryDto, PortalSignInPhase } from "@shared/types.ts";

const props = defineProps<{
  providerId: string;
  /** The provider's own `portalUrl`, used only to prefill an unset base URL. */
  portalUrl: string | null;
}>();

const portal = usePortalAccount(props.providerId);

interface Draft {
  baseUrl: string;
  username: string;
  password: string;
  mfaContact: string;
  otpSenderDomain: string;
}

const draft = reactive<Draft>({
  baseUrl: "",
  username: "",
  password: "",
  mfaContact: "",
  otpSenderDomain: "",
});
const seeded = ref(false);

// Seeds the base URL once the account has loaded, from whatever it already has
// or, failing that, the provider's own portal URL -- and never again, so a
// poll tick bringing a fresh DTO in mid-edit cannot clobber what the owner just
// typed. `seeded` (not a bare module- or top-level binding) is what
// unicorn/no-top-level-assignment-in-function wants for a flag written from
// inside this callback.
watch(
  portal.account.data,
  (value) => {
    if (seeded.value || portal.account.loading.value) return;
    seeded.value = true;
    draft.baseUrl = value?.baseUrl ?? props.portalUrl ?? "";
  },
  { immediate: true },
);

const save = useAction();
const confirmSave = useAction();
const signIn = useAction();
const syncNow = useAction();
const forgetting = useAction();
const removing = useAction();
const confirmingForget = ref(false);
const confirmingRemove = ref(false);

const hasCredentials = computed(() => portal.account.data.value?.hasCredentials ?? false);
const hasSession = computed(() => portal.account.data.value?.hasSession ?? false);
const hasMfaContact = computed(() => portal.account.data.value?.hasMfaContact ?? false);
const hasOtpSender = computed(() => portal.account.data.value?.hasOtpSender ?? false);
const state = computed(() => portal.account.data.value?.state ?? "none");
// `data.value` can be null (nothing has loaded yet); once it is not, `signIn`
// is always present -- `GET .../portal` synthesizes a default rather than
// 404ing, per `PortalAccountStatusDto`'s own doc comment in shared/types.ts.
const phase = computed<PortalSignInPhase | undefined>(
  () => portal.account.data.value?.signIn.phase,
);

/** "none" / "active" / "needs re-auth" / "signing in…", in the spec's own words. */
const badgeLabel = computed(() => {
  if (phase.value && isPortalSignInInProgress(phase.value)) return "signing in…";
  if (state.value === "active") return "active";
  return state.value === "needs_reauth" ? "needs re-auth" : "none";
});

const PHASE_TEXT: Partial<Record<PortalSignInPhase, string>> = {
  logging_in: "Signing in…",
  awaiting_code: "Waiting for the emailed code — it arrives via your Gmail forwarding filter",
  validating: "Checking the code…",
  signed_in: "Signed in",
};

/**
 * The runner's own phase and the account row's own state can describe two
 * different sign-in attempts -- see `effectiveSignIn`'s own comment -- so this
 * is the freshest of the two, not simply `signIn` off the wire.
 */
const outcome = computed(() =>
  portal.account.data.value === null ? null : effectiveSignIn(portal.account.data.value),
);

const phaseLine = computed<string | null>(() => {
  const eff = outcome.value;
  if (eff === null || eff.phase === "idle") return null;
  if (eff.phase === "failed") {
    return `Failed: ${eff.code === null ? "the sign-in failed" : codeMessage(eff.code)}`;
  }
  return PHASE_TEXT[eff.phase] ?? null;
});

const canSave = computed(() => draft.username.trim() !== "" && draft.password !== "");

/**
 * What `POST .../portal/discover` last reported, waiting for the owner's Confirm.
 *
 * Null means there is nothing to confirm -- either nothing has been probed yet,
 * or the save went through. Cleared whenever the base URL is edited, because the
 * origin on screen would then no longer be the one the owner is about to agree
 * to.
 */
const discovered = ref<PortalDiscoveryDto | null>(null);
watch(
  () => draft.baseUrl,
  () => {
    discovered.value = null;
  },
);

/** The origin of a URL, or null when it is not one. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Save, in the two steps the Worker requires.
 *
 * A password change against the portal already stored needs no probe: that
 * origin was confirmed when it was stored, so it is passed straight back as
 * `confirmedOrigin`. Anything else -- a first save, or a different host -- runs
 * discovery first and shows the owner where it landed, because the origin the
 * chain settles on is where their portal password will be POSTed.
 */
async function onSave(): Promise<void> {
  const typed = draft.baseUrl.trim();
  const known = portal.account.data.value?.baseUrl ?? null;
  const sameAsStored = known !== null && (typed === "" || originOf(typed) === known);
  if (sameAsStored) {
    await save.run(() => submit(known));
    return;
  }
  await save.run(async () => {
    discovered.value = await endpoints.discoverPortal(props.providerId, { baseUrl: typed });
  });
}

/** Step two: the owner has read the origin on screen and agreed to it. */
async function onConfirm(): Promise<void> {
  const origin = discovered.value?.origin;
  if (origin === undefined) return;
  await confirmSave.run(() => submit(origin));
}

/** The PUT itself, against an origin the owner has confirmed. */
async function submit(confirmedOrigin: string): Promise<void> {
  const baseUrl = draft.baseUrl.trim();
  const mfaContact = draft.mfaContact.trim();
  const otpSenderDomain = draft.otpSenderDomain.trim();
  const saved = await endpoints.savePortalAccount(props.providerId, {
    username: draft.username,
    password: draft.password,
    confirmedOrigin,
    ...(baseUrl !== "" && { baseUrl }),
    ...(mfaContact !== "" && { mfaContact }),
    ...(otpSenderDomain !== "" && { otpSenderDomain }),
  });
  portal.account.set(saved);
  toastSuccess("Portal login saved.");
  // The password (and the username, which travelled with it) is never kept
  // around once it has been sent -- the fields go back to blank exactly like
  // ProviderEditor's own client-secret field does.
  draft.username = "";
  draft.password = "";
  draft.mfaContact = "";
  draft.otpSenderDomain = "";
  discovered.value = null;
}

/**
 * Whether the last `POST .../portal/sign-in` actually queued a job -- a `ref`
 * (not a bare `let`) for the same reason `seeded` above is one: it is written
 * from inside the callback `onSignIn` hands to `signIn.run`.
 */
const signInStarted = ref(false);

async function onSignIn(): Promise<void> {
  // `started: false` means the button did not actually queue anything -- the
  // hourly cron already holds the sign-in gate, or an existing job has not
  // gone stale yet (see `PortalSignInRunner.start`). Polling unconditionally in
  // that case, as this used to, watches a phase nothing is about to move: the
  // very first tick finds it not in progress and stops, and the button reverts
  // to "Sign in now" within a few seconds even though a sign-in may genuinely
  // still be running elsewhere.
  const ok = await signIn.run(async () => {
    const result = await endpoints.startPortalSignIn(props.providerId);
    signInStarted.value = result.started;
    if (result.started) toastSuccess("Sign-in started.");
  });
  if (!ok) return;
  if (signInStarted.value) {
    portal.pollSignIn();
    return;
  }
  // Refresh once instead of announcing a sign-in that never started, then keep
  // polling only if that refresh shows one is genuinely still in progress.
  await portal.account.reload();
  const live = portal.account.data.value?.signIn.phase;
  if (live !== undefined && isPortalSignInInProgress(live)) portal.pollSignIn();
}

async function onSync(): Promise<void> {
  await syncNow.run(async () => {
    await endpoints.syncPortalNow(props.providerId);
    toastSuccess("Portal sync started.");
  });
}

async function onForgetSession(): Promise<void> {
  const ok = await forgetting.run(async () => {
    await endpoints.forgetPortalSession(props.providerId);
    toastSuccess("Portal session forgotten.");
  });
  confirmingForget.value = false;
  if (ok) await portal.account.reload();
}

async function onRemove(): Promise<void> {
  const ok = await removing.run(async () => {
    await endpoints.removePortalAccount(props.providerId);
    toastSuccess("Portal login removed.");
  });
  confirmingRemove.value = false;
  if (ok) await portal.account.reload();
}
</script>

<template>
  <div class="portal">
    <div class="row">
      <h4>MyChart portal</h4>
      <span class="chip" :class="{ 'danger-text': state === 'needs_reauth' }">
        {{ badgeLabel }}
      </span>
    </div>

    <StateBlock
      :loading="portal.account.loading.value"
      :error="portal.account.error.value"
      loading-text="Loading the portal login…"
      @retry="portal.account.reload()"
    >
      <p v-if="phaseLine" class="muted">{{ phaseLine }}</p>

      <div class="fields two">
        <label class="field">
          Portal base URL
          <input v-model="draft.baseUrl" type="url" autocomplete="off" placeholder="optional" />
        </label>
        <label class="field">
          Username
          <input v-model="draft.username" autocomplete="username" />
        </label>
        <label class="field">
          Password <span class="muted">{{ hasCredentials ? "stored" : "not set" }}</span>
          <input
            v-model="draft.password"
            type="password"
            autocomplete="new-password"
            placeholder="new password"
          />
        </label>
        <label class="field">
          Email for verification codes (if different from your username)
          <span class="muted">{{ hasMfaContact ? "stored" : "not set" }}</span>
          <input
            v-model="draft.mfaContact"
            type="email"
            autocomplete="off"
            placeholder="optional"
          />
        </label>
        <label class="field">
          Sender of your verification-code emails, e.g. the domain part
          <span class="muted">{{ hasOtpSender ? "stored" : "not set" }}</span>
          <input
            v-model="draft.otpSenderDomain"
            name="otpSenderDomain"
            autocomplete="off"
            placeholder="optional — learned after the first successful code"
          />
        </label>
      </div>

      <p v-if="discovered" class="muted confirm-line">
        Portal found at <strong>{{ discovered.origin }}</strong> ({{ discovered.flavor }}). Your
        password will be sent there — confirm to store it.
      </p>

      <div class="row">
        <button class="primary" :disabled="!canSave || save.busy.value" @click="onSave">
          {{ save.busy.value ? "Checking…" : "Save" }}
        </button>
        <button
          v-if="discovered"
          class="primary"
          :disabled="!canSave || confirmSave.busy.value"
          @click="onConfirm"
        >
          {{ confirmSave.busy.value ? "Saving…" : "Confirm and save" }}
        </button>
        <button
          class="small"
          :disabled="!hasCredentials || signIn.busy.value || portal.polling.value"
          @click="onSignIn"
        >
          {{ signIn.busy.value || portal.polling.value ? "Signing in…" : "Sign in now" }}
        </button>
        <button class="small" :disabled="!hasCredentials || syncNow.busy.value" @click="onSync">
          {{ syncNow.busy.value ? "Syncing…" : "Sync upcoming now" }}
        </button>
        <button class="small danger" :disabled="!hasSession" @click="confirmingForget = true">
          Forget session
        </button>
        <button
          class="small danger spacer"
          :disabled="!hasCredentials"
          @click="confirmingRemove = true"
        >
          Remove login
        </button>
      </div>

      <p v-if="portal.account.data.value?.lastOkAt" class="muted">
        Last ok {{ relativeTime(portal.account.data.value.lastOkAt) }}
      </p>
    </StateBlock>

    <ConfirmDialog
      v-if="confirmingForget"
      title="Forget this portal session?"
      body="The stored cookie jar is dropped. Signing in again will be needed before the next sync."
      confirm-label="Forget"
      :busy="forgetting.busy.value"
      @cancel="confirmingForget = false"
      @confirm="onForgetSession"
    />
    <ConfirmDialog
      v-if="confirmingRemove"
      title="Remove this portal login?"
      body="The stored username, password and session are deleted. Portal syncing stops for this provider until a login is saved again."
      confirm-label="Remove"
      :busy="removing.busy.value"
      @cancel="confirmingRemove = false"
      @confirm="onRemove"
    />
  </div>
</template>

<style scoped>
.portal {
  display: grid;
  gap: 10px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}

h4 {
  font-size: 0.9rem;
  margin: 0;
}

.confirm-line strong {
  overflow-wrap: anywhere;
}
</style>
