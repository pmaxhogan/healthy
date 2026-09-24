<script setup lang="ts">
// Builds (or edits) one exposure rule.
//
// For the kind of rule that matters most -- hiding fields -- it is a visual
// builder rather than a text box: pick what the rule applies to (every tool, one
// tool, or one resource type, and optionally one health system), then tick the
// fields to hide in a tree of the real structure of those answers, arrays and
// all. A live preview runs the draft over a real item of the owner's own data
// and shows it before and after, and says how many items it would change. A
// path the tree does not show can still be typed, with autocomplete from it.
//
// Everything is checked by the Worker, not here: the preview doubles as live
// validation, and a draft it refuses comes back with the sentence saying why.

import { computed, onUnmounted, ref, watch } from "vue";

import { canonicalPath } from "@shared/policy-path.ts";

import { ApiRequestError, errorMessage, isAuthRequired } from "../api/client.ts";
import { endpoints } from "../api/endpoints.ts";
import { debounce } from "../lib/debounce.ts";
import {
  allPaths,
  buildTree,
  changedTools,
  fieldSentence,
  keptSelection,
  noChangeReason,
  overlayStructure,
  previewLabel,
  readablePath,
  shapesFor,
} from "../lib/policy.ts";
import { toastSuccess } from "../lib/toasts.ts";

import FieldTree from "./FieldTree.vue";
import PolicyPreview from "./PolicyPreview.vue";

import type {
  FieldRuleSpec,
  HealthSystemDto,
  McpToolInfoDto,
  PolicyPreviewDto,
  PolicyRuleDto,
  PolicyRuleType,
  PolicySchemaDto,
  PolicyStructureDto,
  PolicyToolPreviewDto,
} from "@shared/types.ts";

const props = withDefaults(
  defineProps<{
    schema: PolicySchemaDto;
    tools: McpToolInfoDto[];
    healthSystems: HealthSystemDto[];
    /** The rule being edited, or null to build a new one. */
    editing?: PolicyRuleDto | null;
  }>(),
  { editing: null },
);

const emit = defineEmits<{ saved: [rule: PolicyRuleDto]; cancel: [] }>();

type Kind = "field" | "allow" | "tool" | "resource" | "health_system";
type ScopeKind = "all" | "tool" | "resource";

const KINDS: { value: Kind; label: string }[] = [
  { value: "field", label: "Hide fields" },
  { value: "tool", label: "Block a tool" },
  { value: "resource", label: "Hide a resource type" },
  { value: "health_system", label: "Hide a health system" },
  { value: "allow", label: "Show a withheld field" },
];

const kind = ref<Kind>("field");
const scopeKind = ref<ScopeKind>("all");
const tool = ref("");
const resourceType = ref("");
/** With a tool scope: only that tool's items of this type ("" for all of them). */
const toolType = ref("");
const healthSystemId = ref("");
const paths = ref<string[]>([]);
const search = ref("");
const rawPath = ref("");
const rawPathError = ref<string | null>(null);
const target = ref("");
const note = ref("");

const saving = ref(false);
const problems = ref<string[]>([]);

const toolNames = computed(() => props.schema.tools.map((entry) => entry.name));
const descriptions = computed(
  () => new Map(props.tools.map((entry) => [entry.name, entry.description])),
);
const healthSystemNames = computed(
  () => new Map(props.healthSystems.map((entry) => [entry.id, entry.displayName])),
);

function healthSystemName(id: string): string {
  return healthSystemNames.value.get(id) ?? id;
}

const isField = computed(() => kind.value === "field" || kind.value === "allow");

// --- scope --------------------------------------------------------------------

const scope = computed(() => {
  if (scopeKind.value === "tool" && tool.value !== "") {
    return { tool: tool.value, resourceType: toolType.value === "" ? null : toolType.value };
  }
  return {
    tool: null,
    resourceType:
      scopeKind.value === "resource" && resourceType.value !== "" ? resourceType.value : null,
  };
});

/** The resource types one tool can answer with, for the "only items of" narrowing. */
const typesOfTool = computed(() => {
  if (tool.value === "") return [];
  const types = shapesFor(props.schema, { tool: tool.value, resourceType: null })
    .map((shape) => shape.resourceType)
    .filter((type): type is string => type !== null);
  return [...new Set(types)];
});

const spec = computed<FieldRuleSpec>(() => ({
  effect: kind.value === "allow" ? "allow" : "hide",
  tool: scope.value.tool,
  resourceType: scope.value.resourceType,
  healthSystemId: healthSystemId.value === "" ? null : healthSystemId.value,
  paths: paths.value,
}));

// --- the tree, with the owner's own key structure over it --------------------

const structures = ref(new Map<string, PolicyStructureDto>());

/**
 * The tool whose real answer the tree's "in your data" overlay is read from:
 * the scope's own tool, or the first tool that carries the scope's type.
 */
const structureTool = computed(() => {
  if (scope.value.tool !== null) return scope.value.tool;
  if (scope.value.resourceType === null) return "";
  const typed = new Set(
    props.schema.shapes
      .filter((shape) => shape.resourceType === scope.value.resourceType)
      .map((shape) => shape.id),
  );
  const tool = props.schema.tools.find((entry) => entry.shapes.some((shape) => typed.has(shape)));
  return tool?.name ?? "";
});

function structureKey(): string {
  return `${structureTool.value}|${scope.value.resourceType ?? ""}`;
}

const structureState = ref<"idle" | "loading" | "failed">("idle");

async function loadStructure(): Promise<void> {
  const key = structureKey();
  if (structureTool.value === "" || structures.value.has(key)) return;
  structureState.value = "loading";
  try {
    const structure = await endpoints.policyStructure({
      tool: structureTool.value,
      ...(scope.value.resourceType !== null && { resourceType: scope.value.resourceType }),
    });
    const next = new Map(structures.value);
    next.set(key, structure);
    structures.value = next;
    structureState.value = "idle";
  } catch (error) {
    structureState.value = isAuthRequired(error) ? "idle" : "failed";
  }
}

const groups = computed(() => {
  const tree = buildTree(props.schema, scope.value);
  const structure = structures.value.get(structureKey());
  return structure === undefined ? tree : overlayStructure(tree, structure);
});

const suggestions = computed(() => allPaths(groups.value));

function toggle(path: string): void {
  paths.value = paths.value.includes(path)
    ? paths.value.filter((entry) => entry !== path)
    : [...paths.value, path];
}

function addRawPath(): void {
  const path = canonicalPath(rawPath.value);
  if (path === null) {
    rawPathError.value = "That is not a path: dots between field names, [] after a list.";
    return;
  }
  rawPathError.value = null;
  if (!paths.value.includes(path)) paths.value = [...paths.value, path];
  rawPath.value = "";
}

// --- preview ---------------------------------------------------------------
//
// One request runs the draft over every tool its scope reaches. The dropdown
// lists only the tools it changes, each with its count; when it changes
// nothing, an empty state says so and why, instead of a dropdown to click
// through.

const preview = ref<PolicyPreviewDto | null>(null);
const previewState = ref<"idle" | "loading" | "failed">("idle");
/** Bumped on every run, so an answer that arrives after a newer request is dropped. */
const previewRun = ref(0);
/** The tool whose before/after is shown; always one of `previewOptions`, or "". */
const previewTool = ref("");

const previewOptions = computed(() => changedTools(preview.value));

// The selection follows the options: kept while its tool still changes, else
// the first tool that does, else nothing (the empty state).
watch(previewOptions, (options) => {
  previewTool.value = keptSelection(previewTool.value, options);
});

const selectedPreview = computed<PolicyToolPreviewDto | null>(
  () => previewOptions.value.find((entry) => entry.tool === previewTool.value) ?? null,
);

const emptyReason = computed(() =>
  preview.value === null ? "" : noChangeReason(preview.value, spec.value),
);

function problemsOf(error: unknown): string[] {
  if (error instanceof ApiRequestError) {
    const list = error.details?.problems;
    if (Array.isArray(list))
      return list.filter((entry): entry is string => typeof entry === "string");
  }
  return [errorMessage(error)];
}

async function runPreview(): Promise<void> {
  previewRun.value += 1;
  if (!isField.value || paths.value.length === 0) {
    preview.value = null;
    problems.value = [];
    return;
  }
  const token = previewRun.value;
  previewState.value = "loading";
  try {
    const result = await endpoints.policyPreview({
      ...(scope.value.resourceType !== null && { resourceType: scope.value.resourceType }),
      field: spec.value,
    });
    if (token !== previewRun.value) return;
    preview.value = result;
    problems.value = [];
    previewState.value = "idle";
  } catch (error) {
    if (token !== previewRun.value || isAuthRequired(error)) return;
    preview.value = null;
    problems.value = problemsOf(error);
    previewState.value = "failed";
  }
}

const schedulePreview = debounce(() => {
  void runPreview();
}, 450);

watch(spec, () => {
  schedulePreview();
});

watch([structureTool, () => scope.value.resourceType], () => {
  if (isField.value && scopeKind.value !== "all") void loadStructure();
});

onUnmounted(() => {
  schedulePreview.cancel();
});

// --- editing --------------------------------------------------------------------

function reset(): void {
  kind.value = "field";
  scopeKind.value = "all";
  tool.value = "";
  resourceType.value = "";
  toolType.value = "";
  healthSystemId.value = "";
  paths.value = [];
  target.value = "";
  note.value = "";
  search.value = "";
  rawPath.value = "";
  problems.value = [];
  preview.value = null;
}

function load(rule: PolicyRuleDto): void {
  reset();
  note.value = rule.note ?? "";
  if (rule.ruleType !== "field") {
    kind.value = rule.ruleType;
    target.value = rule.target;
    return;
  }
  const field = rule.field;
  if (field === null) return;
  kind.value = field.effect === "allow" ? "allow" : "field";
  if (field.tool !== null) {
    scopeKind.value = "tool";
    tool.value = field.tool;
    toolType.value = field.resourceType ?? "";
  } else if (field.resourceType !== null) {
    scopeKind.value = "resource";
    resourceType.value = field.resourceType;
  }
  healthSystemId.value = field.healthSystemId ?? "";
  paths.value = [...field.paths];
}

watch(
  () => props.editing,
  (rule) => {
    if (rule === null) reset();
    else load(rule);
  },
  { immediate: true },
);

// --- saving ----------------------------------------------------------------

const targetOptions = computed<{ value: string; label: string }[]>(() => {
  switch (kind.value) {
    case "tool": {
      return toolNames.value.map((name) => ({ value: name, label: name }));
    }
    case "resource": {
      return props.schema.resourceTypes.map((type) => ({ value: type, label: type }));
    }
    case "health_system": {
      return props.healthSystems.map((entry) => ({ value: entry.id, label: entry.displayName }));
    }
    default: {
      return [];
    }
  }
});

const sentence = computed(() =>
  paths.value.length === 0 ? "" : fieldSentence(spec.value, healthSystemName),
);

const valid = computed(() => (isField.value ? paths.value.length > 0 : target.value !== ""));

async function save(): Promise<void> {
  if (!valid.value || saving.value) return;
  saving.value = true;
  problems.value = [];
  const trimmed = note.value.trim();
  const ruleType: PolicyRuleType = isField.value ? "field" : (kind.value as PolicyRuleType);
  try {
    let rule: PolicyRuleDto;
    if (props.editing === null) {
      rule = await endpoints.createPolicyRule({
        ruleType,
        ...(isField.value ? { field: spec.value } : { target: target.value }),
        ...(trimmed !== "" && { note: trimmed }),
      });
      toastSuccess("Rule added.");
    } else {
      rule = await endpoints.updatePolicyRule(props.editing.id, {
        ...(isField.value ? { field: spec.value } : { target: target.value }),
        note: trimmed === "" ? null : trimmed,
      });
      toastSuccess("Rule saved.");
    }
    reset();
    emit("saved", rule);
  } catch (error) {
    if (!isAuthRequired(error)) problems.value = problemsOf(error);
  } finally {
    saving.value = false;
  }
}

/** Changing the rule's kind keeps nothing that belonged to the old kind. */
function setKind(next: Kind): void {
  if (props.editing !== null) return;
  kind.value = next;
  paths.value = [];
  target.value = "";
  problems.value = [];
  preview.value = null;
}
</script>

<template>
  <form class="builder" @submit.prevent="save">
    <div class="row kinds" role="radiogroup" aria-label="What the rule does">
      <button
        v-for="option in KINDS"
        :key="option.value"
        type="button"
        role="radio"
        class="small"
        :class="{ primary: kind === option.value }"
        :aria-checked="kind === option.value"
        :disabled="editing !== null && kind !== option.value"
        @click="setKind(option.value)"
      >
        {{ option.label }}
      </button>
    </div>

    <template v-if="!isField">
      <label class="field">
        {{ kind === "tool" ? "Tool" : kind === "resource" ? "Resource type" : "Health system" }}
        <select v-model="target" data-test="target">
          <option value="" disabled>Choose…</option>
          <option v-for="option in targetOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <p v-if="kind === 'tool' && target !== ''" class="muted">
        {{ descriptions.get(target) ?? "" }} The tool stops answering at all.
      </p>
    </template>

    <template v-else>
      <fieldset class="scope">
        <legend>Applies to</legend>
        <div class="row">
          <label class="radio">
            <input v-model="scopeKind" type="radio" value="all" name="scope" /> Every tool
          </label>
          <label class="radio">
            <input v-model="scopeKind" type="radio" value="tool" name="scope" /> One tool
          </label>
          <label class="radio">
            <input v-model="scopeKind" type="radio" value="resource" name="scope" /> One resource
            type
          </label>
        </div>
        <div class="fields two">
          <label v-if="scopeKind === 'tool'" class="field">
            Tool
            <select v-model="tool" data-test="scope-tool">
              <option value="" disabled>Choose a tool…</option>
              <option v-for="name in toolNames" :key="name" :value="name">{{ name }}</option>
            </select>
          </label>
          <label v-if="scopeKind === 'tool' && typesOfTool.length > 1" class="field">
            Only its items of type
            <select v-model="toolType">
              <option value="">Every type it returns</option>
              <option v-for="type in typesOfTool" :key="type" :value="type">{{ type }}</option>
            </select>
          </label>
          <label v-if="scopeKind === 'resource'" class="field">
            Resource type
            <select v-model="resourceType" data-test="scope-resource">
              <option value="" disabled>Choose a type…</option>
              <option v-for="type in schema.resourceTypes" :key="type" :value="type">
                {{ type }}
              </option>
            </select>
          </label>
          <label class="field">
            Health system
            <select v-model="healthSystemId" data-test="scope-health-system">
              <option value="">All health systems</option>
              <option v-for="entry in healthSystems" :key="entry.id" :value="entry.id">
                {{ entry.displayName }}
              </option>
            </select>
          </label>
        </div>
        <p v-if="scopeKind === 'tool' && tool !== ''" class="muted">
          {{ descriptions.get(tool) ?? "" }}
        </p>
      </fieldset>

      <div class="picker">
        <div class="row">
          <label class="field grow">
            {{ kind === "allow" ? "Field to put back" : "Fields to hide" }}
            <input
              v-model="search"
              type="search"
              placeholder="Search fields, e.g. address or display"
              autocomplete="off"
              spellcheck="false"
              data-test="field-search"
            />
          </label>
          <span v-if="structureState === 'loading'" class="muted">Reading your data…</span>
          <span v-else-if="structureState === 'failed'" class="muted">
            Could not read your data's fields; the model's are shown.
          </span>
        </div>
        <FieldTree
          :groups="groups"
          :selected="paths"
          :search="search"
          :sensitive-only="kind === 'allow'"
          @toggle="toggle"
        />
        <p class="muted legend">
          <span class="dot" aria-hidden="true" /> in your cached data · “list” fields apply to every
          element · a picked field takes everything under it
        </p>

        <details class="advanced">
          <summary>Type a path instead</summary>
          <div class="row">
            <input
              v-model="rawPath"
              class="grow"
              list="policy-path-suggestions"
              placeholder="e.g. component[].referenceRange[].low"
              autocomplete="off"
              spellcheck="false"
              data-test="raw-path"
              @keydown.enter.prevent="addRawPath"
            />
            <button type="button" class="small" @click="addRawPath">Add path</button>
          </div>
          <datalist id="policy-path-suggestions">
            <option v-for="path in suggestions" :key="path" :value="path" />
          </datalist>
          <p v-if="rawPathError" class="warn-text">{{ rawPathError }}</p>
          <p class="muted">
            Dots between field names; <code>[]</code> after a list means every element;
            <code>value[x]</code> is every form of a FHIR choice field.
          </p>
        </details>

        <div v-if="paths.length > 0" class="row picked" data-test="picked">
          <span class="muted">Picked:</span>
          <span v-for="path in paths" :key="path" class="chip picked-chip">
            <code>{{ readablePath(path) }}</code>
            <button
              type="button"
              class="remove"
              :aria-label="`Remove ${path}`"
              @click="toggle(path)"
            >
              ×
            </button>
          </span>
        </div>
      </div>

      <p v-if="sentence" class="sentence" data-test="draft-sentence">{{ sentence }}</p>

      <div class="preview-box">
        <div class="row">
          <h3>Preview</h3>
          <label
            v-if="previewState !== 'loading' && previewOptions.length > 0"
            class="field inline spacer"
          >
            in
            <select v-model="previewTool" data-test="preview-tool">
              <option v-for="entry in previewOptions" :key="entry.tool" :value="entry.tool">
                {{ previewLabel(entry) }}
              </option>
            </select>
          </label>
        </div>
        <p v-if="paths.length === 0" class="muted">
          Pick a field to see it removed from a real item of your data.
        </p>
        <p v-else-if="previewState === 'loading'" class="muted">Running the rule on your data…</p>
        <div
          v-else-if="preview !== null && previewOptions.length === 0"
          class="empty"
          data-test="preview-empty"
        >
          <strong>{{
            kind === "allow"
              ? "This rule doesn't put anything back in your current data."
              : "This rule doesn't change anything in your current data."
          }}</strong>
          <p class="muted">{{ emptyReason }}</p>
        </div>
        <PolicyPreview
          v-else-if="selectedPreview !== null"
          :preview="selectedPreview"
          :allow="kind === 'allow'"
        />
      </div>
    </template>

    <ul v-if="problems.length > 0" class="problems" data-test="problems">
      <li v-for="problem in problems" :key="problem">{{ problem }}</li>
    </ul>

    <label class="field">
      Note <span class="muted">optional, for your own benefit later</span>
      <input v-model="note" autocomplete="off" />
    </label>

    <div class="row">
      <button class="primary" type="submit" :disabled="!valid || saving" data-test="save">
        {{ saving ? "Saving…" : editing === null ? "Add rule" : "Save changes" }}
      </button>
      <button v-if="editing !== null" type="button" @click="emit('cancel')">Cancel</button>
    </div>
  </form>
</template>

<style scoped>
.builder {
  display: grid;
  gap: 14px;
  min-width: 0;
}

.kinds {
  gap: 6px;
}

.scope {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px 12px;
  margin: 0;
  display: grid;
  gap: 10px;
  min-width: 0;
}

legend {
  font-size: 0.85rem;
  color: var(--text-dim);
  padding: 0 4px;
}

.radio {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.92rem;
}

.picker {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.grow {
  flex: 1 1 220px;
  min-width: 0;
}

.legend {
  font-size: 0.8rem;
}

.dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  vertical-align: middle;
}

.advanced summary {
  cursor: pointer;
  font-size: 0.88rem;
  color: var(--text-dim);
}

.advanced {
  display: grid;
  gap: 6px;
}

.advanced[open] {
  gap: 8px;
}

.picked {
  gap: 6px;
}

.picked-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text);
}

.remove {
  padding: 0 4px;
  background: none;
  color: var(--text-dim);
  line-height: 1;
}

.sentence {
  margin: 0;
  padding: 8px 12px;
  border-left: 3px solid var(--accent);
  background: var(--bg);
  border-radius: 4px;
  font-size: 0.92rem;
}

.preview-box {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.empty {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  font-size: 0.92rem;
}

.preview-box h3 {
  font-size: 0.95rem;
}

.field.inline {
  display: flex;
  align-items: center;
  gap: 6px;
}

.problems {
  margin: 0;
  padding: 8px 12px 8px 28px;
  border: 1px solid var(--danger);
  border-radius: 8px;
  color: var(--danger);
  font-size: 0.88rem;
  display: grid;
  gap: 4px;
}

.warn-text {
  color: var(--warn);
  font-size: 0.85rem;
  margin: 0;
}
</style>
