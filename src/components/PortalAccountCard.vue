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
import { usePortalAccount } from "../lib/use-portal-account.ts";

import ConfirmDialog from "./ConfirmDialog.vue";
import StateBlock from "./StateBlock.vue";

import type { PortalSignInPhase } from "@shared/types.ts";

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
}

const draft = reactive<Draft>({ baseUrl: "", username: "", password: "", mfaContact: "" });
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
const signIn = useAction();
const syncNow = useAction();
const forgetting = useAction();
const removing = useAction();
const confirmingForget = ref(false);
const confirmingRemove = ref(false);

const hasCredentials = computed(() => portal.account.data.value?.hasCredentials ?? false);
const hasSession = computed(() => portal.account.data.value?.hasSession ?? false);
const hasMfaContact = computed(() => portal.account.data.value?.hasMfaContact ?? false);
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

const phaseLine = computed<string | null>(() => {
  const p = phase.value;
  if (!p || p === "idle") return null;
  if (p === "failed") {
    // The stable failure code lives on `signIn.code`, not the account's own
    // `lastErrorCode` -- the sign-in runner's progress is tracked separately
    // from the durable session state (see `PortalSignInState` in
    // shared/types.ts), and it is this attempt's code that belongs here.
    const code = portal.account.data.value?.signIn.code ?? null;
    return `Failed: ${code === null ? "the sign-in failed" : codeMessage(code)}`;
  }
  return PHASE_TEXT[p] ?? null;
});

const canSave = computed(() => draft.username.trim() !== "" && draft.password !== "");

async function onSave(): Promise<void> {
  const baseUrl = draft.baseUrl.trim();
  const username = draft.username;
  const password = draft.password;
  const mfaContact = draft.mfaContact.trim();
  const ok = await save.run(async () => {
    const saved = await endpoints.savePortalAccount(props.providerId, {
      username,
      password,
      ...(baseUrl !== "" && { baseUrl }),
      ...(mfaContact !== "" && { mfaContact }),
    });
    portal.account.set(saved);
    toastSuccess("Portal login saved.");
  });
  // The password (and the username, which travelled with it) is never kept
  // around once it has been sent -- the field goes back to blank exactly like
  // ProviderEditor's own client-secret field does.
  if (!ok) {
    return;
  }

  draft.username = "";
  draft.password = "";
  draft.mfaContact = "";
}

async function onSignIn(): Promise<void> {
  const ok = await signIn.run(async () => {
    await endpoints.startPortalSignIn(props.providerId);
    toastSuccess("Sign-in started.");
  });
  if (ok) portal.pollSignIn();
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
      </div>

      <div class="row">
        <button class="primary" :disabled="!canSave || save.busy.value" @click="onSave">
          {{ save.busy.value ? "Saving…" : "Save" }}
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
</style>
