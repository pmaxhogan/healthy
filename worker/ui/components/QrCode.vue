<script setup lang="ts">
// A QR code as inline SVG.
//
// One `<path>` of horizontal runs rather than a rect per module: a version-12
// symbol is thousands of modules, and one element is what the browser handles
// cheaply. The colours are presentation attributes, not `style=""` (the page's
// CSP forbids inline styles) and are fixed black on white whatever the theme:
// scanners expect dark modules on a light field, and the white also carries the
// quiet zone the specification requires.

import { computed } from "vue";

import { encodeQr } from "../lib/qr.ts";

const props = withDefaults(
  defineProps<{
    /** The text to encode. */
    value: string;
    /** Accessible name. Never put the encoded text here: it may be a secret. */
    label?: string;
  }>(),
  { label: "QR code" },
);

/** Light modules around the symbol, in modules. The specification asks for four. */
const QUIET_ZONE = 4;

const code = computed(() => encodeQr(props.value));
const extent = computed(() => code.value.size + QUIET_ZONE * 2);

const path = computed(() => {
  const parts: string[] = [];
  for (const [y, row] of code.value.modules.entries()) {
    let x = 0;
    while (x < row.length) {
      if (row[x] === true) {
        const start = x;
        while (x < row.length && row[x] === true) x++;
        parts.push(
          `M${String(start + QUIET_ZONE)} ${String(y + QUIET_ZONE)}h${String(x - start)}v1h-${String(x - start)}z`,
        );
      } else {
        x++;
      }
    }
  }
  return parts.join("");
});
</script>

<template>
  <svg
    class="qr"
    role="img"
    :aria-label="label"
    :viewBox="`0 0 ${String(extent)} ${String(extent)}`"
    shape-rendering="crispEdges"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect :width="extent" :height="extent" fill="#ffffff" />
    <path :d="path" fill="#000000" />
  </svg>
</template>

<style scoped>
.qr {
  display: block;
  width: 100%;
  max-width: 320px;
  height: auto;
  border-radius: 8px;
}
</style>
