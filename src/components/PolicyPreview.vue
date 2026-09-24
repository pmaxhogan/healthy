<script setup lang="ts">
// A draft rule's effect on one real item: before, with what the rule removes
// struck through and highlighted, and after, as the assistant would receive it.
//
// The item is the owner's own data, fetched for the admin UI only (see
// `worker/mcp/policy-sample.ts`); nothing here is logged or kept.

import { computed, ref } from "vue";

import { diffLines } from "../lib/policy.ts";

import type { DiffLine } from "../lib/policy.ts";
import type { PolicyToolPreviewDto } from "@shared/types.ts";

const props = defineProps<{ preview: PolicyToolPreviewDto; allow: boolean }>();

type View = "item" | "raw";
const view = ref<View>("item");

const hasRaw = computed(() => props.preview.sample?.rawBefore !== undefined);

const pair = computed(() => {
  const sample = props.preview.sample;
  if (sample === null) return null;
  return view.value === "raw" && hasRaw.value
    ? { before: sample.rawBefore, after: sample.rawAfter }
    : { before: sample.before, after: sample.after };
});

/** Before, marking removals (a hide rule); or after, marking additions (an allow rule). */
const marked = computed<DiffLine[]>(() => {
  if (pair.value === null) return [];
  const { before, after } = pair.value;
  // An allow rule adds: draw the after, marking what the before lacked.
  const [drawn, compared] = props.allow ? [after, before] : [before, after];
  return diffLines(drawn, compared);
});

const plain = computed<DiffLine[]>(() => {
  if (pair.value === null) return [];
  const other = props.allow ? pair.value.before : pair.value.after;
  return diffLines(other, other);
});

const summary = computed(() => {
  const { affected, total, tool } = props.preview;
  if (total === 0) return `${tool} has nothing to show for this scope yet.`;
  const items = total === 1 ? "item" : "items";
  return affected === 0
    ? `Changes none of the ${String(total)} ${items} ${tool} returns.`
    : `Changes ${String(affected)} of the ${String(total)} ${items} ${tool} returns. The first one:`;
});
</script>

<template>
  <div class="preview" data-test="policy-preview">
    <p class="muted">
      <span v-if="preview.synthetic" class="chip">example item, not your data</span>
      {{ summary }}
    </p>
    <div v-if="pair !== null" class="row tabs" role="tablist">
      <button
        type="button"
        role="tab"
        class="small"
        :class="{ primary: view === 'item' }"
        :aria-selected="view === 'item'"
        @click="view = 'item'"
      >
        Item
      </button>
      <button
        v-if="hasRaw"
        type="button"
        role="tab"
        class="small"
        :class="{ primary: view === 'raw' }"
        :aria-selected="view === 'raw'"
        @click="view = 'raw'"
      >
        Raw FHIR
      </button>
      <span v-if="preview.warnings.length > 0" class="muted spacer">
        The answer will say: <code>{{ preview.warnings.join(", ") }}</code>
      </span>
    </div>
    <div v-if="pair !== null" class="panes">
      <div class="pane">
        <h4>{{ allow ? "After" : "Before" }}</h4>
        <pre
          class="json"
        ><span v-for="(line, index) in marked" :key="index" class="line" :class="{ changed: line.removed, gone: line.removed && !allow, back: line.removed && allow }" :style="{ paddingLeft: `${String(line.indent * 14)}px` }">{{ line.text }}</span></pre>
      </div>
      <div class="pane">
        <h4>{{ allow ? "Before" : "After" }}</h4>
        <pre
          class="json"
        ><span v-for="(line, index) in plain" :key="index" class="line" :style="{ paddingLeft: `${String(line.indent * 14)}px` }">{{ line.text }}</span></pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.preview {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.tabs {
  gap: 6px;
}

.panes {
  display: grid;
  gap: 10px;
  grid-template-columns: 1fr;
  min-width: 0;
}

@media (min-width: 760px) {
  .panes {
    grid-template-columns: 1fr 1fr;
  }
}

.pane {
  display: grid;
  gap: 4px;
  min-width: 0;
}

h4 {
  margin: 0;
  font-size: 0.8rem;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.json {
  max-height: 360px;
  overflow: auto;
  font-size: 0.78rem;
  line-height: 1.45;
}

.line {
  display: block;
  white-space: pre;
}

.line.gone {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  text-decoration: line-through;
}

.line.back {
  color: var(--ok);
  background: color-mix(in srgb, var(--ok) 14%, transparent);
}
</style>
