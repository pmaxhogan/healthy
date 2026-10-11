<script setup lang="ts">
// The MCP page's exposure policy: the rule builder and the rules.
//
// Everything is exposed unless a rule removes it; the one rule that adds is
// "show a withheld field", which puts back a field (birth date, subscriber id)
// the server withholds by default. Every rule is enforced by the Worker at the
// one choke point every tool's answer passes through, before `jq`.

import { computed, ref } from "vue";

import { endpoints } from "../api/endpoints.ts";
import { ruleSentence } from "../lib/policy.ts";
import { toastSuccess } from "../lib/toasts.ts";
import { useAction, useLoad } from "../lib/use-load.ts";

import ConfirmDialog from "./ConfirmDialog.vue";
import PolicyRuleBuilder from "./PolicyRuleBuilder.vue";
import PolicyRuleList from "./PolicyRuleList.vue";
import StateBlock from "./StateBlock.vue";

import type { HealthSystemDto, McpToolInfoDto, PolicyRuleDto } from "@shared/types.ts";

const props = defineProps<{ tools: McpToolInfoDto[]; healthSystems: HealthSystemDto[] }>();

const rules = useLoad((signal) => endpoints.policyRules(signal));
const schema = useLoad((signal) => endpoints.policySchema(signal));
const mutate = useAction();

const editing = ref<PolicyRuleDto | null>(null);
const removing = ref<PolicyRuleDto | null>(null);

const names = computed(
  () => new Map(props.healthSystems.map((entry) => [entry.id, entry.displayName])),
);

function healthSystemName(id: string): string {
  return names.value.get(id) ?? id;
}

// A rule the policy engine cannot parse is stored, listed, and enforcing nothing.
// That is the one way this page can mislead -- the owner reads the row and
// believes the exposure is denied -- so it is called out rather than left to be
// noticed. Only a malformed `field` rule can get here; see PolicyRuleDto.
const unparsedRules = computed(() => (rules.data.value ?? []).filter((rule) => rule.unparsed));

async function onSaved(): Promise<void> {
  editing.value = null;
  await rules.reload();
}

async function onToggle(rule: PolicyRuleDto, enabled: boolean): Promise<void> {
  await mutate.run(async () => {
    await endpoints.updatePolicyRule(rule.id, { enabled });
    toastSuccess(enabled ? "Rule on." : "Rule off. It enforces nothing until it is back on.");
  });
  // Either way: on failure the switch has to snap back to what is stored.
  await rules.reload();
}

function onEdit(rule: PolicyRuleDto): void {
  editing.value = rule;
}

async function confirmRemove(): Promise<void> {
  const rule = removing.value;
  if (rule === null) return;
  const ok = await mutate.run(async () => {
    await endpoints.deletePolicyRule(rule.id);
    toastSuccess("Rule removed.");
  });
  removing.value = null;
  if (editing.value?.id === rule.id) editing.value = null;
  if (ok) await rules.reload();
}
</script>

<template>
  <section class="card policy">
    <h2>Exposure policy</h2>
    <p class="muted">
      Everything the tools can reach is exposed unless a rule below removes it. A hidden field is
      removed from every answer the rule reaches — the normalized item and the raw FHIR behind it —
      before an assistant's <code>jq</code> filter runs, so nothing can select it. Birth date and
      insurance member id are withheld by default; “Show a withheld field” puts one back.
    </p>

    <StateBlock
      :loading="schema.loading.value"
      :error="schema.error.value"
      :empty="false"
      @retry="schema.reload()"
    >
      <div v-if="schema.data.value" class="builder-wrap" :class="{ editing: editing !== null }">
        <h3>{{ editing === null ? "New rule" : "Edit rule" }}</h3>
        <PolicyRuleBuilder
          :schema="schema.data.value"
          :tools="tools"
          :health-systems="healthSystems"
          :editing="editing"
          @saved="onSaved"
          @cancel="editing = null"
        />
      </div>
    </StateBlock>

    <p v-if="unparsedRules.length > 0" class="warn-text">
      {{ unparsedRules.length === 1 ? "One rule below denies" : "Some rules below deny" }}
      nothing: the policy engine could not read
      {{ unparsedRules.map((rule) => rule.target).join(", ") }}. Delete it and build it again —
      until then that exposure is open.
    </p>

    <StateBlock
      :loading="rules.loading.value"
      :error="rules.error.value"
      :empty="(rules.data.value ?? []).length === 0"
      empty-text="No rules. Everything the tools can reach is exposed."
      @retry="rules.reload()"
    >
      <PolicyRuleList
        :rules="rules.data.value ?? []"
        :schema="schema.data.value"
        :health-systems="healthSystems"
        :busy="mutate.busy.value"
        :editing-id="editing?.id ?? null"
        @toggle="onToggle"
        @edit="onEdit"
        @remove="removing = $event"
      />
    </StateBlock>

    <ConfirmDialog
      v-if="removing !== null"
      title="Delete this rule?"
      :body="`${ruleSentence(removing, healthSystemName)}. Whatever it removes is exposed again as soon as it is gone.`"
      confirm-label="Delete rule"
      :busy="mutate.busy.value"
      @confirm="confirmRemove"
      @cancel="removing = null"
    />
  </section>
</template>

<style scoped>
.policy h2 {
  font-size: 1.05rem;
}

.builder-wrap {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  min-width: 0;
}

.builder-wrap.editing {
  border-color: var(--accent);
}

.builder-wrap h3 {
  font-size: 0.95rem;
}

.warn-text {
  color: var(--warn);
  font-size: 0.88rem;
  margin: 0;
}
</style>
