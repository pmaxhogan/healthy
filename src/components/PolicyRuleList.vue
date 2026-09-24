<script setup lang="ts">
// The stored rules, each as a sentence, grouped by what they apply to, with the
// tools each one changes, an on/off switch, edit and delete.
//
// A rule the engine cannot read is stored, listed and enforcing nothing -- the
// one way this list could mislead -- so it is called out on its row.

import { computed } from "vue";

import { relativeTime } from "../lib/format.ts";
import { ruleGroup, ruleSentence, toolsAffected } from "../lib/policy.ts";

import type { HealthSystemDto, PolicyRuleDto, PolicySchemaDto } from "@shared/types.ts";

const props = withDefaults(
  defineProps<{
    rules: PolicyRuleDto[];
    schema: PolicySchemaDto | null;
    healthSystems: HealthSystemDto[];
    busy?: boolean;
    editingId?: string | null;
  }>(),
  { busy: false, editingId: null },
);

const emit = defineEmits<{
  toggle: [rule: PolicyRuleDto, enabled: boolean];
  edit: [rule: PolicyRuleDto];
  remove: [rule: PolicyRuleDto];
}>();

const names = computed(
  () => new Map(props.healthSystems.map((entry) => [entry.id, entry.displayName])),
);

function healthSystemName(id: string): string {
  return names.value.get(id) ?? "a health system that no longer exists";
}

/** How many tool chips a row shows before it says "and N more". */
const SHOWN_TOOLS = 4;

const groups = computed(() => {
  const byGroup = new Map<string, PolicyRuleDto[]>();
  for (const rule of props.rules) {
    const key = ruleGroup(rule);
    byGroup.set(key, [...(byGroup.get(key) ?? []), rule]);
  }
  return [...byGroup].map(([label, rules]) => ({ label, rules }));
});

function affected(rule: PolicyRuleDto): { shown: string[]; more: number; all: boolean } {
  const tools = toolsAffected(rule, props.schema);
  const total = props.schema?.tools.length ?? 0;
  return {
    shown: tools.slice(0, SHOWN_TOOLS),
    more: Math.max(0, tools.length - SHOWN_TOOLS),
    all: total > 0 && tools.length === total,
  };
}
</script>

<template>
  <div class="rule-list">
    <section v-for="group in groups" :key="group.label" class="rule-group">
      <h3>{{ group.label }}</h3>
      <ul>
        <li
          v-for="rule in group.rules"
          :key="rule.id"
          class="rule"
          :class="{ off: !rule.enabled, editing: rule.id === editingId }"
          data-test="rule"
        >
          <label class="switch" :title="rule.enabled ? 'On: enforced' : 'Off: not enforced'">
            <input
              type="checkbox"
              :checked="rule.enabled"
              :disabled="busy"
              :aria-label="`${rule.enabled ? 'Turn off' : 'Turn on'}: ${ruleSentence(rule, healthSystemName)}`"
              @change="emit('toggle', rule, ($event.target as HTMLInputElement).checked)"
            />
            <span class="track" aria-hidden="true" />
          </label>
          <div class="body">
            <p class="sentence">
              {{ ruleSentence(rule, healthSystemName) }}
              <span v-if="!rule.enabled" class="chip">off</span>
              <span
                v-if="rule.unparsed"
                class="warn-text"
                title="The policy engine cannot read this rule, so it removes nothing."
              >
                — not enforced
              </span>
            </p>
            <p class="tools muted">
              <template v-if="affected(rule).all">Changes every tool's answers</template>
              <template v-else>
                Changes
                <code v-for="name in affected(rule).shown" :key="name" class="tool">{{
                  name
                }}</code>
                <span v-if="affected(rule).more > 0">and {{ affected(rule).more }} more</span>
              </template>
              · added {{ relativeTime(rule.createdAt) }}
              <template v-if="rule.note"> · {{ rule.note }}</template>
            </p>
          </div>
          <div class="actions">
            <button
              type="button"
              class="small"
              :disabled="busy || rule.unparsed"
              @click="emit('edit', rule)"
            >
              Edit
            </button>
            <button
              type="button"
              class="small danger"
              :disabled="busy"
              @click="emit('remove', rule)"
            >
              Delete
            </button>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.rule-list {
  display: grid;
  gap: 14px;
  min-width: 0;
}

.rule-group {
  display: grid;
  gap: 6px;
  min-width: 0;
}

h3 {
  font-size: 0.82rem;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}

.rule {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  min-width: 0;
}

.rule.off .sentence {
  color: var(--text-dim);
}

.rule.editing {
  border-color: var(--accent);
}

.body {
  flex: 1 1 auto;
  min-width: 0;
  display: grid;
  gap: 2px;
}

.sentence {
  margin: 0;
  font-size: 0.92rem;
  overflow-wrap: anywhere;
}

.tools {
  font-size: 0.8rem;
}

.tool {
  margin-right: 4px;
}

.actions {
  display: flex;
  gap: 6px;
  flex: 0 0 auto;
}

@media (max-width: 560px) {
  .rule {
    flex-wrap: wrap;
  }

  .actions {
    width: 100%;
    justify-content: flex-end;
  }
}

.switch {
  position: relative;
  flex: 0 0 auto;
  width: 34px;
  height: 20px;
  margin-top: 2px;
  cursor: pointer;
}

.switch input {
  position: absolute;
  inset: 0;
  opacity: 0;
  margin: 0;
  cursor: pointer;
}

.track {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  transition: background 0.15s;
}

.track::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--text-dim);
  transition: transform 0.15s;
}

.switch input:checked + .track {
  background: var(--accent);
  border-color: var(--accent);
}

.switch input:checked + .track::after {
  transform: translateX(14px);
  background: var(--accent-text);
}

.switch input:focus-visible + .track {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.warn-text {
  color: var(--warn);
  font-size: 0.85rem;
}
</style>
