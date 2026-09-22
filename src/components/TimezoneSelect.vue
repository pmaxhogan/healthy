<script setup lang="ts">
// The timezone the calendar is rendered in.
//
// The list comes from the browser (`Intl.supportedValuesOf`) rather than from a
// table in this repository. That is not only convenience: the owner's timezone is
// personal configuration, and a hard-coded list with a hard-coded default is how
// it would end up committed.

import { computed } from "vue";

const props = defineProps<{ modelValue: string | null }>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

/** What the browser thinks we are in, offered when nothing is chosen yet. */
const detected = computed(() => {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
});

const zones = computed(() => {
  let list: string[] = [];
  try {
    list = Intl.supportedValuesOf("timeZone");
  } catch {
    // Older engines have no enumeration API; the detected zone plus UTC is
    // enough to keep the control usable.
    list = [];
  }
  const extras = [detected.value, "UTC", props.modelValue].filter(
    (zone): zone is string => zone !== null && zone !== "" && !list.includes(zone),
  );
  return [...extras, ...list];
});
</script>

<template>
  <label class="field">
    Timezone
    <select
      :value="modelValue ?? detected"
      @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="zone in zones" :key="zone" :value="zone">{{ zone }}</option>
    </select>
    <span v-if="modelValue === null" class="muted">
      Not set yet — showing what this browser reports.
    </span>
  </label>
</template>
