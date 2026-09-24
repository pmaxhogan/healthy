<script setup lang="ts">
// The MCP side: is it on, how to connect a client, who is connected, what the
// policy denies, and what has been called.
//
// The audit log records the shape of a call and never its content -- tool,
// client, health system ids, a result count, and a jq program's fingerprint. That is
// why it can be shown here at all.

import { computed, ref, watch } from "vue";

import { endpoints, mcpToolsOrNone } from "../api/endpoints.ts";
import McpToolTester from "../components/McpToolTester.vue";
import PolicyRuleForm from "../components/PolicyRuleForm.vue";
import StateBlock from "../components/StateBlock.vue";
import { formatDateTime, formatDuration, relativeTime } from "../lib/format.ts";
import { toastSuccess } from "../lib/toasts.ts";
import { useAction, useLoad } from "../lib/use-load.ts";

import type { CreatePolicyRuleRequest, McpAuditJqDto } from "@shared/types.ts";

const AUDIT_LIMITS = [25, 50, 100, 250] as const;

const settings = useLoad((signal) => endpoints.settings(signal));
const grants = useLoad((signal) => endpoints.mcpGrants(signal));
const rules = useLoad((signal) => endpoints.policyRules(signal));
const healthSystems = useLoad((signal) => endpoints.healthSystems(signal));
const tools = useLoad((signal) => mcpToolsOrNone(signal));

const auditLimit = ref<number>(50);
const audit = useLoad((signal) => endpoints.mcpAudit(auditLimit.value, signal));
watch(auditLimit, () => {
  void audit.reload();
});

const toggle = useAction();
const addRule = useAction();
const mutate = useAction();

const enabled = computed(() => settings.data.value?.mcpEnabled ?? false);
const serverUrl = computed(() => `${location.origin}/mcp`);
const timezone = computed(() => settings.data.value?.timezone ?? null);
// A Map, not a record: the keys come from audit rows and indexing an object with
// them is what security/detect-object-injection is there to flag.
const healthSystemNames = computed(
  () => new Map((healthSystems.data.value ?? []).map((p) => [p.id, p.displayName])),
);

function nameHealthSystem(id: string): string {
  return healthSystemNames.value.get(id) ?? id;
}

// A jq program is audited as a fingerprint, never its text (a filter can name
// what the caller was looking for): the hash prefix, its length, and how many
// items went in and came out.
function describeJq(jq: McpAuditJqDto | null): string {
  if (jq === null) return "—";
  const head = `${jq.sha256.slice(0, 8)} · ${String(jq.length)} ch`;
  if (jq.inputCount === null) return head;
  const out = jq.outputCount === null ? "failed" : String(jq.outputCount);
  return `${head} · ${String(jq.inputCount)} → ${out}`;
}

// A rule the policy engine cannot parse is stored, listed, and enforcing nothing.
// That is the one way this page can mislead -- the owner reads the row and
// believes the exposure is denied -- so it is called out rather than left to be
// noticed. Only a malformed `field` target can get here; see PolicyRuleDto.
const unparsedRules = computed(() => (rules.data.value ?? []).filter((rule) => rule.unparsed));

async function setEnabled(next: boolean): Promise<void> {
  const ok = await toggle.run(async () => {
    const saved = await endpoints.saveSettings({ mcpEnabled: next });
    settings.set(saved);
    toastSuccess(next ? "MCP enabled." : "MCP disabled.");
  });
  if (!ok) await settings.reload();
}

async function onAddRule(rule: CreatePolicyRuleRequest): Promise<void> {
  const ok = await addRule.run(async () => {
    await endpoints.createPolicyRule(rule);
    toastSuccess("Rule added.");
  });
  if (ok) await rules.reload();
}

async function onDeleteRule(id: string): Promise<void> {
  const ok = await mutate.run(async () => {
    await endpoints.deletePolicyRule(id);
    toastSuccess("Rule removed.");
  });
  if (ok) await rules.reload();
}

async function onRevoke(id: string): Promise<void> {
  const ok = await mutate.run(async () => {
    await endpoints.revokeMcpGrant(id);
    toastSuccess("Client revoked.");
  });
  if (ok) await grants.reload();
}
</script>

<template>
  <div class="page">
    <section class="card">
      <div class="row">
        <h2>Model Context Protocol</h2>
        <label class="toggle spacer">
          <input
            type="checkbox"
            :checked="enabled"
            :disabled="toggle.busy.value || settings.loading.value"
            @change="setEnabled(($event.target as HTMLInputElement).checked)"
          />
          {{ enabled ? "enabled" : "disabled" }}
        </label>
      </div>
      <p class="muted">
        When it is off the endpoint stops answering, existing links included. Nothing is revoked.
      </p>
    </section>

    <section class="card">
      <h2>Connecting a client</h2>
      <p class="muted">Server URL — add it as a custom connector in claude.ai:</p>
      <pre>{{ serverUrl }}</pre>
      <ol class="steps">
        <li>In claude.ai, add a custom connector and paste the URL above.</li>
        <li>
          The consent page is behind Cloudflare Access and then the admin password: complete both,
          then approve the connection.
        </li>
        <li>The client appears below, and every call it makes is logged.</li>
      </ol>
    </section>

    <section class="card">
      <h2>Linked clients</h2>
      <StateBlock
        :loading="grants.loading.value"
        :error="grants.error.value"
        :empty="(grants.data.value ?? []).length === 0"
        empty-text="Nothing is connected."
        @retry="grants.reload()"
      >
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th>Scope</th>
                <th>Linked</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="grant in grants.data.value ?? []" :key="grant.id">
                <td>{{ grant.clientName ?? grant.clientId }}</td>
                <td>{{ grant.scope.join(" ") }}</td>
                <td class="nowrap" :title="formatDateTime(grant.createdAt, timezone)">
                  {{ relativeTime(grant.createdAt) }}
                </td>
                <td class="nowrap">{{ relativeTime(grant.lastUsedAt) }}</td>
                <td class="nowrap">
                  <button
                    class="small danger"
                    :disabled="mutate.busy.value"
                    @click="onRevoke(grant.id)"
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </StateBlock>
    </section>

    <section class="card">
      <h2>Exposure policy</h2>
      <p class="muted">
        Everything is exposed unless a rule below denies it. A field rule written as
        <code>allow:Patient.telecom</code> does the opposite: it re-permits a field that is withheld
        by default.
      </p>

      <PolicyRuleForm
        :tools="tools.data.value ?? []"
        :health-systems="healthSystems.data.value ?? []"
        :busy="addRule.busy.value"
        @submit="onAddRule"
      />

      <p v-if="unparsedRules.length > 0" class="warn-text">
        {{ unparsedRules.length === 1 ? "One rule below denies" : "Some rules below deny" }}
        nothing: the policy engine could not read
        {{ unparsedRules.map((rule) => rule.target).join(", ") }}. A field rule has to be
        <code>ResourceType.path.to.field</code> (or <code>allow:</code> one). Delete and re-add it —
        until then that exposure is open.
      </p>

      <StateBlock
        :loading="rules.loading.value"
        :error="rules.error.value"
        :empty="(rules.data.value ?? []).length === 0"
        empty-text="No rules. Everything the tools can reach is exposed."
        @retry="rules.reload()"
      >
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Target</th>
                <th>Note</th>
                <th>Added</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="rule in rules.data.value ?? []" :key="rule.id">
                <td class="nowrap">{{ rule.ruleType }}</td>
                <td>
                  <code>{{ rule.target }}</code>
                  <span
                    v-if="rule.unparsed"
                    class="warn-text"
                    title="The policy engine cannot read this target, so the rule denies nothing."
                  >
                    — not enforced
                  </span>
                </td>
                <td>{{ rule.note ?? "—" }}</td>
                <td class="nowrap">{{ relativeTime(rule.createdAt) }}</td>
                <td class="nowrap">
                  <button
                    class="small danger"
                    :disabled="mutate.busy.value"
                    @click="onDeleteRule(rule.id)"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </StateBlock>
    </section>

    <McpToolTester />

    <section class="card">
      <div class="row">
        <h2>Audit log</h2>
        <label class="field inline spacer">
          Show
          <select v-model.number="auditLimit">
            <option v-for="limit in AUDIT_LIMITS" :key="limit" :value="limit">{{ limit }}</option>
          </select>
        </label>
      </div>

      <StateBlock
        :loading="audit.loading.value"
        :error="audit.error.value"
        :empty="(audit.data.value ?? []).length === 0"
        empty-text="No calls yet."
        @retry="audit.reload()"
      >
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tool</th>
                <th>When</th>
                <th>Client</th>
                <th>Health systems</th>
                <th class="num">Results</th>
                <th>jq</th>
                <th>Result</th>
                <th class="num">Took</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in audit.data.value ?? []" :key="entry.id">
                <td class="nowrap">{{ entry.tool }}</td>
                <td class="nowrap" :title="formatDateTime(entry.ts, timezone)">
                  {{ relativeTime(entry.ts) }}
                </td>
                <td>{{ entry.clientId }}</td>
                <td>{{ entry.healthSystemIds.map(nameHealthSystem).join(", ") || "—" }}</td>
                <td class="num">{{ entry.resultCount }}</td>
                <td
                  class="nowrap"
                  :title="entry.jq === null ? undefined : `jq program SHA-256 ${entry.jq.sha256}`"
                >
                  {{ describeJq(entry.jq) }}
                </td>
                <td class="nowrap" :class="{ 'danger-text': !entry.ok }">
                  {{ entry.ok ? "ok" : (entry.errorCode ?? "error") }}
                </td>
                <td class="num">{{ formatDuration(entry.durationMs) }}</td>
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

.warn-text {
  color: var(--warn);
  font-size: 0.88rem;
}

.toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.9rem;
}

.field.inline {
  display: flex;
  align-items: center;
  gap: 8px;
}

.steps {
  margin: 0;
  padding-left: 20px;
  color: var(--text-dim);
  font-size: 0.88rem;
  display: grid;
  gap: 4px;
}
</style>
