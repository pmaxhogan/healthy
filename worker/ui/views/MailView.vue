<script setup lang="ts">
// The inbound 2FA mailbox: what has arrived, the pending Gmail forwarding
// verification (if any), and the sender allowlist that decides what the
// Worker's email() handler keeps versus setReject()s.
//
// See docs/mail.md for the end-to-end flow this page is the front door for.

import { computed, ref, watch } from "vue";

import { endpoints } from "../api/endpoints.ts";
import StateBlock from "../components/StateBlock.vue";
import { formatDateTime, relativeTime } from "../lib/format.ts";
import { toastSuccess } from "../lib/toasts.ts";
import { useAction, useLoad } from "../lib/use-load.ts";

import type { MailKind } from "@shared/types.ts";

const inbox = useLoad((signal) => endpoints.mailInbox(signal));
const mailSettings = useLoad((signal) => endpoints.mailSettings(signal));
const settings = useLoad((signal) => endpoints.settings(signal));

const savingAllowlist = useAction();
const sendingTest = useAction();

const timezone = computed(() => settings.data.value?.timezone ?? null);

/** The most recent still-informative Gmail forwarding-verification entry. */
const pendingVerification = computed(() =>
  (inbox.data.value ?? []).find(
    (entry) => entry.kind === "forward_verify" && entry.pendingCode !== null,
  ),
);

/**
 * Defense in depth for `pendingVerification.pendingUrl`: a URL out of an
 * email body is untrusted input all the way to the browser, so this template
 * never renders an `<a href>` from it without checking the scheme here too --
 * even though the Worker's classify.ts already refuses to extract, seal or
 * return anything but a real `https://…google.com` link in the first place.
 * A `javascript:` or `data:` URL fails `new URL()`'s protocol check and is
 * simply not linked.
 */
function isSafeHttpsUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** A draft the owner edits; re-seeded whenever the loaded settings change underneath it. */
const allowlistText = ref("");
watch(
  () => mailSettings.data.value,
  (value) => {
    if (value) allowlistText.value = value.allowlist.join(", ");
  },
  { immediate: true },
);

const allowlistEntries = computed(() =>
  allowlistText.value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0),
);

async function saveAllowlist(): Promise<void> {
  if (allowlistEntries.value.length === 0) return;
  const ok = await savingAllowlist.run(async () => {
    const saved = await endpoints.saveMailSettings(allowlistEntries.value);
    mailSettings.set(saved);
    toastSuccess("Sender allowlist saved.");
  });
  if (!ok) await mailSettings.reload();
}

async function sendTest(): Promise<void> {
  await sendingTest.run(async () => {
    await endpoints.sendMailTest();
    toastSuccess("Test entry added to the inbox below.");
    await inbox.reload();
  });
}

function kindLabel(kind: MailKind): string {
  if (kind === "otp") return "login code";
  return kind === "forward_verify" ? "Gmail verification" : "other";
}
</script>

<template>
  <div class="page">
    <section class="card">
      <h2>Set up Gmail forwarding</h2>
      <p class="muted">
        One-time setup so a MyChart login code emailed to your inbox also reaches this Worker,
        without ever leaving your own Gmail account.
      </p>
      <ol class="checklist">
        <li>
          In Gmail: <strong>Settings → Forwarding and POP/IMAP → Add a forwarding address</strong>,
          and enter this Worker's mail address (the one Cloudflare Email Routing points at it, e.g.
          <code>2fa@&lt;your worker hostname&gt;</code>).
        </li>
        <li>
          Gmail sends a confirmation message to that address. It shows up as a
          <strong>Gmail verification</strong> row below within a few seconds — open the card above
          it on this page and either click the link or paste the code back into Gmail's dialog.
        </li>
        <li>
          Create a filter:
          <strong>Settings → Filters and Blocked Addresses → Create a new filter</strong>, matching
          the sender/subject of your MyChart login-code emails, then check
          <strong>only</strong> "Forward it to" your new address. Leave "Skip the Inbox" and "Delete
          it" unchecked, so the original stays in your Gmail inbox too.
        </li>
      </ol>
    </section>

    <section v-if="pendingVerification" class="card highlight">
      <h2>Pending Gmail verification</h2>
      <p class="muted">Gmail is waiting for this forwarding address to be confirmed.</p>
      <div class="fields two">
        <div class="field">
          <span>Confirmation code</span>
          <code class="code-value">{{ pendingVerification.pendingCode }}</code>
        </div>
        <div v-if="isSafeHttpsUrl(pendingVerification.pendingUrl)" class="field">
          <span>Confirmation link</span>
          <a :href="pendingVerification.pendingUrl ?? ''" target="_blank" rel="noopener noreferrer">
            open it
          </a>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>Sender allowlist</h2>
      <p class="muted">
        Comma-separated sender domains the inbound email handler accepts mail from. Anything else is
        rejected before it is even parsed. Each entry is a whole domain of at least two labels, and
        it matches that domain or a subdomain of it — never a partial word, so
        <code>example.org</code> allows <code>mail.example.org</code> and nothing else.
      </p>
      <StateBlock
        :loading="mailSettings.loading.value"
        :error="mailSettings.error.value"
        @retry="mailSettings.reload()"
      >
        <div class="field">
          <span>Allowed sender domains</span>
          <textarea
            v-model="allowlistText"
            rows="2"
            placeholder="portal.example.org, google.com"
          ></textarea>
        </div>
        <div class="row">
          <button
            :disabled="savingAllowlist.busy.value || allowlistEntries.length === 0"
            @click="saveAllowlist"
          >
            {{ savingAllowlist.busy.value ? "Saving…" : "Save allowlist" }}
          </button>
          <span v-for="entry in allowlistEntries" :key="entry" class="chip">{{ entry }}</span>
        </div>
      </StateBlock>
    </section>

    <section class="card">
      <div class="row">
        <h2>Recent inbox</h2>
        <button class="small spacer" :disabled="sendingTest.busy.value" @click="sendTest">
          {{ sendingTest.busy.value ? "Sending…" : "Send test entry" }}
        </button>
      </div>
      <StateBlock
        :loading="inbox.loading.value"
        :error="inbox.error.value"
        :empty="(inbox.data.value ?? []).length === 0"
        empty-text="Nothing has arrived yet."
        @retry="inbox.reload()"
      >
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Kind</th>
                <th>Sender domain</th>
                <th>Subject</th>
                <th>Received</th>
                <th>Consumed</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in inbox.data.value ?? []" :key="entry.id">
                <td>{{ kindLabel(entry.kind) }}</td>
                <td>{{ entry.fromDomain }}</td>
                <td>{{ entry.subject ?? "—" }}</td>
                <td class="nowrap">
                  {{ formatDateTime(entry.receivedAt, timezone) }} ({{
                    relativeTime(entry.receivedAt)
                  }})
                </td>
                <td>{{ entry.consumedAt ? "yes" : "no" }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </StateBlock>
    </section>
  </div>
</template>

<style scoped>
h2 {
  font-size: 1.05rem;
}

.checklist {
  margin: 0;
  padding-left: 1.25em;
  display: grid;
  gap: 8px;
  font-size: 0.9rem;
}

.highlight {
  border-color: var(--accent);
}

.code-value {
  font-size: 1.1rem;
  letter-spacing: 0.05em;
}
</style>
