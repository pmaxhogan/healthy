<script setup lang="ts">
// The field picker: every shape a rule's scope reaches, as an expandable tree of
// the fields in it, with a checkbox per field.
//
// Arrays are marked "list": a field picked under one is removed from every
// element. A field is also marked when it is withheld by default, when the
// owner's own cached data has it ("in your data"), and when only the owner's
// data has it and the model does not ("not modelled"). Search matches a field's
// path and its description, and opens the way to every match.

import { computed, ref } from "vue";

import { visibleRows } from "../lib/policy.ts";

import type { TreeGroup, TreeRow } from "../lib/policy.ts";

const props = withDefaults(
  defineProps<{
    groups: TreeGroup[];
    selected: string[];
    search?: string;
    /** Allow-rule mode: only fields withheld by default can be picked. */
    sensitiveOnly?: boolean;
  }>(),
  { search: "", sensitiveOnly: false },
);

const emit = defineEmits<{ toggle: [path: string] }>();

/** `group|path` for every opened node; `group|` for every opened group. */
const expanded = ref(new Set<string>());

const selectedSet = computed(() => new Set(props.selected));
const searching = computed(() => props.search.trim() !== "");

function groupKey(group: TreeGroup): string {
  return `${group.id}|`;
}

function groupOpen(group: TreeGroup): boolean {
  // One group needs no header to be opened; a search opens every group it matches in.
  return props.groups.length === 1 || searching.value || expanded.value.has(groupKey(group));
}

function toggleKey(key: string): void {
  const next = new Set(expanded.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expanded.value = next;
}

const rows = computed(() =>
  props.groups.map((group) => ({
    group,
    rows: groupOpen(group) ? visibleRows(group, expanded.value, props.search) : [],
  })),
);

const visibleGroups = computed(() =>
  rows.value.filter((entry) => !searching.value || entry.rows.length > 0),
);

/** A path an ancestor already hides: shown ticked and not pickable on its own. */
function covered(path: string): boolean {
  for (const picked of props.selected) {
    if (path !== picked && (path.startsWith(`${picked}.`) || path.startsWith(`${picked}[]`))) {
      return true;
    }
  }
  return false;
}

function pickable(row: TreeRow): boolean {
  return !props.sensitiveOnly || (row.node.sensitive && row.depth === 0);
}
</script>

<template>
  <div class="tree">
    <p v-if="searching && visibleGroups.length === 0" class="muted">
      No field matches “{{ search.trim() }}”. A path the tree does not know can still go in the raw
      path box below.
    </p>
    <section v-for="entry in visibleGroups" :key="entry.group.id" class="group">
      <button
        v-if="groups.length > 1"
        type="button"
        class="group-head"
        :aria-expanded="groupOpen(entry.group)"
        @click="toggleKey(groupKey(entry.group))"
      >
        <span class="caret" aria-hidden="true">{{ groupOpen(entry.group) ? "▾" : "▸" }}</span>
        {{ entry.group.label }}
        <span class="chip">{{ entry.group.vocabulary === "raw" ? "raw FHIR" : "item" }}</span>
      </button>
      <ul v-if="groupOpen(entry.group)" class="rows">
        <li
          v-for="row in entry.rows"
          :key="`${row.group}|${row.node.path}`"
          class="tree-row"
          :style="{ paddingLeft: `${String(row.depth * 18)}px` }"
        >
          <button
            v-if="row.expandable && !searching"
            type="button"
            class="expander"
            :aria-label="`${row.expanded ? 'Collapse' : 'Expand'} ${row.node.name}`"
            :aria-expanded="row.expanded"
            @click="toggleKey(`${row.group}|${row.node.path}`)"
          >
            {{ row.expanded ? "▾" : "▸" }}
          </button>
          <span v-else class="expander-space" aria-hidden="true" />
          <label class="pick" :class="{ disabled: !pickable(row) }">
            <input
              type="checkbox"
              :checked="selectedSet.has(row.node.path) || covered(row.node.path)"
              :disabled="!pickable(row) || covered(row.node.path)"
              :data-path="row.node.path"
              @change="emit('toggle', row.node.path)"
            />
            <code class="name">{{ row.node.name }}</code>
            <span v-if="row.node.array" class="tag" title="A list: applies to every element">
              list
            </span>
            <span v-if="row.node.sensitive" class="tag warn" title="Withheld unless allowed">
              withheld by default
            </span>
            <span v-if="row.node.observedOnly" class="tag" title="Seen in your data only">
              not modelled
            </span>
            <span
              v-else-if="row.node.seen"
              class="seen"
              title="Present in your cached data"
              aria-label="in your data"
            />
            <span v-if="row.node.description" class="desc">{{ row.node.description }}</span>
          </label>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.tree {
  display: grid;
  gap: 6px;
  max-height: 420px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px;
  background: var(--bg);
  min-width: 0;
}

.group {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  font-weight: 600;
  font-size: 0.9rem;
  background: var(--bg-raised);
  padding: 6px 8px;
}

.caret {
  width: 12px;
  color: var(--text-dim);
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.tree-row {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
}

.expander,
.expander-space {
  flex: 0 0 22px;
  width: 22px;
  padding: 2px 0;
  background: none;
  color: var(--text-dim);
  font-size: 0.8rem;
}

.pick {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  border-radius: 6px;
  cursor: pointer;
  min-width: 0;
  font-size: 0.9rem;
}

.pick:hover {
  background: var(--bg-raised);
}

.pick.disabled {
  cursor: default;
  opacity: 0.6;
}

.name {
  color: var(--text);
}

.tag {
  font-size: 0.72rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 7px;
  color: var(--text-dim);
}

.tag.warn {
  color: var(--warn);
  border-color: var(--warn);
}

.seen {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
}

.desc {
  color: var(--text-dim);
  font-size: 0.82rem;
}
</style>
