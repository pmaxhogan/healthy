<script setup lang="ts">
// An instant shown as "5 min ago" that gives the exact date and time when it is
// pressed, and goes back when pressed again.
//
// A `title` alone is no use on a phone, and "10 mo ago" is too coarse to act on.
// `now` comes from the page's clock so every instant on it ticks together. An
// absent instant renders as plain text with no title: there is no date to show.

import { computed, ref } from "vue";

import { formatDateTime, relativeTime } from "../lib/format.ts";

const props = withDefaults(
  defineProps<{ iso: string | null; timezone: string | null; now: number; empty?: string }>(),
  { empty: "—" },
);

const exact = ref(false);
const absolute = computed(() => formatDateTime(props.iso, props.timezone));
</script>

<template>
  <button
    v-if="iso"
    type="button"
    class="reltime"
    :title="exact ? 'Show how long ago' : absolute"
    :aria-pressed="exact"
    @click="exact = !exact"
  >
    <time :datetime="iso">{{ exact ? absolute : relativeTime(iso, now) }}</time>
  </button>
  <template v-else>{{ empty }}</template>
</template>

<style scoped>
.reltime {
  padding: 0;
  border-radius: 2px;
  background: none;
  color: inherit;
  text-align: inherit;
  text-decoration: underline dotted var(--border);
  text-underline-offset: 3px;
}
</style>
