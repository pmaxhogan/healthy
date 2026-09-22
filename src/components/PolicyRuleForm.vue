<script setup lang="ts">
// Adds one exposure rule.
//
// The policy is allow-all with a deny list, enforced at a single choke point in
// the Worker before anything is serialised. So a rule here *removes* something
// from what the MCP will hand out -- except a field target written with the
// `allow:` prefix, which re-permits a field that is denied by default because it
// is sensitive.

import { computed, ref } from "vue";

import { RESOURCE_TYPES } from "../lib/fhir-resources.ts";

import type { CreatePolicyRuleRequest } from "../api/endpoints.ts";
import type { McpToolInfoDto, PolicyRuleType, ProviderDto } from "@shared/types.ts";

const props = withDefaults(
  defineProps<{
    tools: McpToolInfoDto[];
    providers: ProviderDto[];
    busy?: boolean;
  }>(),
  { busy: false },
);

const emit = defineEmits<{ submit: [rule: CreatePolicyRuleRequest] }>();

const ruleType = ref<PolicyRuleType>("tool");
const target = ref("");
const note = ref("");

const HINTS: Record<PolicyRuleType, string> = {
  tool: "An MCP tool name. The tool stops being offered at all.",
  resource: "A FHIR resource type. Nothing of that type is returned by any tool.",
  field:
    "A path like ResourceType.path.to.field. Prefix with allow: to re-permit a field that is denied by default.",
  provider: "A provider. Its data is excluded from every tool.",
};

/** Datalist options for the current rule type. */
const suggestions = computed<string[]>(() => {
  switch (ruleType.value) {
    case "tool": {
      return props.tools.map((tool) => tool.name);
    }
    case "resource": {
      return [...RESOURCE_TYPES];
    }
    case "provider": {
      return props.providers.map((provider) => provider.id);
    }
    case "field": {
      return RESOURCE_TYPES.map((type) => `${type}.`);
    }
  }
});

const valid = computed(() => target.value.trim() !== "");

function submit(): void {
  const trimmed = target.value.trim();
  if (trimmed === "") return;
  const trimmedNote = note.value.trim();
  emit("submit", {
    ruleType: ruleType.value,
    target: trimmed,
    ...(trimmedNote !== "" && { note: trimmedNote }),
  });
  target.value = "";
  note.value = "";
}
</script>

<template>
  <form class="form" @submit.prevent="submit">
    <div class="fields two">
      <label class="field">
        Rule type
        <select v-model="ruleType">
          <option value="tool">Tool</option>
          <option value="resource">Resource type</option>
          <option value="field">Field path</option>
          <option value="provider">Provider</option>
        </select>
      </label>

      <label class="field">
        Target
        <input
          v-model="target"
          list="policy-target-suggestions"
          autocomplete="off"
          spellcheck="false"
          placeholder="what the rule applies to"
        />
      </label>
    </div>

    <datalist id="policy-target-suggestions">
      <option v-for="value in suggestions" :key="value" :value="value" />
    </datalist>

    <p class="muted">{{ HINTS[ruleType] }}</p>

    <label class="field">
      Note <span class="muted">optional, for your own benefit later</span>
      <input v-model="note" autocomplete="off" />
    </label>

    <div class="row">
      <button class="primary" type="submit" :disabled="!valid || busy">
        {{ busy ? "Adding…" : "Add rule" }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.form {
  display: grid;
  gap: 12px;
  min-width: 0;
}
</style>
