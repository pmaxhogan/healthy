<script setup lang="ts">
// Arrive-early minutes: one default for the provider, plus overrides keyed by
// visit type.
//
// The override keys are free text because that is what Epic sends as a visit
// type -- there is no code list to pick from, so the owner types the text they
// see on a card and the Worker matches it case-insensitively.

import { computed, ref } from "vue";

const props = defineProps<{
  /** Provider-wide default, or null to inherit the global setting. */
  modelValue: number | null;
  overrides: Record<string, number>;
  /** Shown as the value that a null default falls back to. */
  inheritedDefault: number;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: number | null];
  "update:overrides": [value: Record<string, number>];
}>();

const newType = ref("");
const newMinutes = ref(0);

function byVisitType(a: [string, number], b: [string, number]): number {
  return a[0].localeCompare(b[0]);
}

const rows = computed(() => {
  const entries = Object.entries(props.overrides);
  return entries.toSorted(byVisitType);
});

/** A whole, non-negative number of minutes. Anything unparseable becomes zero. */
function clampMinutes(raw: string | number): number {
  const rounded = Math.round(Number(raw));
  return Number.isFinite(rounded) && rounded > 0 ? Math.min(rounded, 1440) : 0;
}

function onDefaultInput(raw: string): void {
  const trimmed = raw.trim();
  emit("update:modelValue", trimmed === "" ? null : clampMinutes(trimmed));
}

function addOverride(): void {
  const key = newType.value.trim();
  if (key === "") return;
  emit("update:overrides", { ...props.overrides, [key]: clampMinutes(newMinutes.value) });
  newType.value = "";
  newMinutes.value = 0;
}

function removeOverride(key: string): void {
  const next = { ...props.overrides };
  // `delete` on a copy, keyed by a string that came from our own Object.entries
  // above -- not from user input reaching a prototype chain.
  Reflect.deleteProperty(next, key);
  emit("update:overrides", next);
}

function setOverride(key: string, raw: string): void {
  emit("update:overrides", { ...props.overrides, [key]: clampMinutes(raw) });
}
</script>

<template>
  <div class="wrap">
    <label class="field">
      Arrive early (minutes)
      <input
        :value="modelValue ?? ''"
        type="number"
        min="0"
        max="240"
        :placeholder="`${inheritedDefault} (default)`"
        @input="onDefaultInput(($event.target as HTMLInputElement).value)"
      />
    </label>

    <p class="muted">Per visit type, if some appointments want a different lead time.</p>

    <table v-if="rows.length > 0">
      <tbody>
        <tr v-for="[type, minutes] in rows" :key="type">
          <td>{{ type }}</td>
          <td class="num narrow">
            <input
              :value="minutes"
              type="number"
              min="0"
              max="240"
              :aria-label="`Minutes for ${type}`"
              @input="setOverride(type, ($event.target as HTMLInputElement).value)"
            />
          </td>
          <td class="nowrap">
            <button class="small danger" type="button" @click="removeOverride(type)">Remove</button>
          </td>
        </tr>
      </tbody>
    </table>

    <div class="row">
      <input
        v-model="newType"
        class="grow"
        placeholder="Visit type"
        autocomplete="off"
        aria-label="Visit type"
        @keydown.enter.prevent="addOverride"
      />
      <input
        v-model.number="newMinutes"
        class="mins"
        type="number"
        min="0"
        max="240"
        aria-label="Minutes"
      />
      <button class="small" type="button" :disabled="newType.trim() === ''" @click="addOverride">
        Add
      </button>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.grow {
  flex: 1;
  min-width: 120px;
}

.mins {
  width: 80px;
}

.narrow input {
  width: 80px;
}
</style>
