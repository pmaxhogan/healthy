<script setup lang="ts">
// "Try a tool": lets the owner call any MCP tool directly from the admin console
// and see exactly what an MCP client would see -- the same input schema
// validation, the same exposure policy, the same audit row (as the admin
// console, not an OAuth client; see worker/mcp/admin-call.ts).
//
// The heavy read-only JSON viewer (CodeMirror) is not imported here -- it is
// loaded with `defineAsyncComponent` below, so it never enters this page's
// bundle at all until a call has actually been made. Schema validation
// (`@cfworker/json-schema`) has no such split: it has no `new Function`/`eval`
// (this app's CSP has no `unsafe-eval`) and is small enough that splitting it out
// would just be another network round trip for no benefit.

import { Validator } from "@cfworker/json-schema";
import { computed, defineAsyncComponent, ref, watch } from "vue";

import { ApiRequestError, errorMessage, isAuthRequired } from "../api/client.ts";
import { endpoints } from "../api/endpoints.ts";
import { formatDuration } from "../lib/format.ts";
import { buildArgsSkeleton } from "../lib/mcp-schema.ts";
import { useLoad } from "../lib/use-load.ts";

import StateBlock from "./StateBlock.vue";

import type { McpToolSchemaDto } from "@shared/types.ts";

const AsyncJsonViewer = defineAsyncComponent(() => import("./JsonViewer.vue"));

type Outcome =
  | { kind: "ok"; isError: boolean; data: unknown; durationMs: number }
  | { kind: "error"; message: string; issues?: string[] };

interface Attempt {
  name: string;
  arguments: Record<string, unknown>;
  outcome: Outcome;
}

const schemas = useLoad((signal) => endpoints.mcpToolSchemas(signal));

const selectedName = ref("");
const argsText = ref("{}");
const parseError = ref<string | null>(null);
const schemaIssues = ref<string[]>([]);
const busy = ref(false);
const attempt = ref<Attempt | null>(null);

const selectedTool = computed<McpToolSchemaDto | null>(
  () => (schemas.data.value ?? []).find((tool) => tool.name === selectedName.value) ?? null,
);

const valid = computed(
  () => selectedTool.value !== null && parseError.value === null && schemaIssues.value.length === 0,
);

// The list loads asynchronously; pick a starting tool (and its skeleton) the
// first time it arrives, and again if the picked one ever disappears.
watch(
  () => schemas.data.value,
  (list) => {
    const names = new Set((list ?? []).map((tool) => tool.name));
    if (!names.has(selectedName.value)) selectedName.value = list?.[0]?.name ?? "";
  },
  { immediate: true },
);

watch(selectedTool, (tool) => {
  attempt.value = null;
  argsText.value = tool ? JSON.stringify(buildArgsSkeleton(tool.inputSchema), null, 2) : "{}";
});

function validate(): void {
  parseError.value = null;
  schemaIssues.value = [];
  if (selectedTool.value === null) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(argsText.value);
  } catch (error) {
    parseError.value = error instanceof Error ? error.message : "invalid JSON";
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    parseError.value = "must be a JSON object";
    return;
  }

  const validator = new Validator(selectedTool.value.inputSchema, "7", false);
  const result = validator.validate(parsed);
  if (!result.valid) {
    schemaIssues.value = result.errors.map(
      (issue) => `${issue.instanceLocation || "/"} ${issue.error}`,
    );
  }
}

watch([argsText, selectedTool], validate, { immediate: true });

async function run(): Promise<void> {
  if (busy.value || !valid.value || selectedTool.value === null) return;
  const name = selectedTool.value.name;
  // `valid` guarantees this parses and is a plain object.
  const args = JSON.parse(argsText.value) as Record<string, unknown>;

  busy.value = true;
  try {
    const response = await endpoints.callMcpTool(name, args);
    attempt.value = {
      name,
      arguments: args,
      outcome: {
        kind: "ok",
        isError: response.result.isError,
        data: response.result.data,
        durationMs: response.durationMs,
      },
    };
  } catch (error) {
    if (isAuthRequired(error)) return;
    const issues =
      error instanceof ApiRequestError && Array.isArray(error.details?.issues)
        ? (error.details.issues as string[])
        : undefined;
    // The bare sentence, not `errorMessage(error)`: that helper now appends a
    // reformatted `details.issues` to the message too (tuned for a validation
    // error's `path: rule` shape, e.g. a Mail allowlist entry), and an MCP
    // schema rejection's one issue is the SDK's own full sentence -- showing it
    // once, verbatim, in the list below is clearer than folding a mangled copy
    // into the paragraph above it as well.
    const message =
      issues !== undefined && error instanceof ApiRequestError
        ? error.message
        : errorMessage(error);
    attempt.value = {
      name,
      arguments: args,
      outcome: { kind: "error", message, ...(issues && { issues }) },
    };
  } finally {
    busy.value = false;
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (!((event.ctrlKey || event.metaKey) && event.key === "Enter")) {
    return;
  }

  event.preventDefault();
  void run();
}
</script>

<template>
  <section class="card">
    <h2>Try a tool</h2>
    <p class="muted">
      Calls the tool exactly as a linked client would: the same validation, the same exposure
      policy, and it is written to the audit log below as <code>admin-console</code>.
    </p>

    <StateBlock
      :loading="schemas.loading.value"
      :error="schemas.error.value"
      :empty="(schemas.data.value ?? []).length === 0"
      empty-text="No tools available."
      @retry="schemas.reload()"
    >
      <label class="field">
        Tool
        <select v-model="selectedName">
          <option v-for="tool in schemas.data.value ?? []" :key="tool.name" :value="tool.name">
            {{ tool.name }}
          </option>
        </select>
      </label>
      <p v-if="selectedTool" class="muted">{{ selectedTool.description }}</p>

      <label class="field">
        Arguments (JSON)
        <textarea
          v-model="argsText"
          class="args-editor"
          rows="7"
          spellcheck="false"
          autocomplete="off"
          @keydown="onKeydown"
        />
      </label>
      <p v-if="parseError" class="warn-text">{{ parseError }}</p>
      <ul v-else-if="schemaIssues.length > 0" class="warn-text issues">
        <li v-for="issue in schemaIssues" :key="issue">{{ issue }}</li>
      </ul>

      <div class="row">
        <button class="primary" type="button" :disabled="!valid || busy" @click="run">
          {{ busy ? "Running…" : "Run" }}
        </button>
        <span class="muted">Ctrl/Cmd+Enter runs</span>
      </div>
    </StateBlock>

    <div v-if="attempt" class="attempt">
      <div class="viewer-block">
        <h3>Request</h3>
        <Suspense>
          <component
            :is="AsyncJsonViewer"
            :value="{ name: attempt.name, arguments: attempt.arguments }"
          />
          <template #fallback><p class="muted">Loading viewer…</p></template>
        </Suspense>
      </div>

      <div v-if="attempt.outcome.kind === 'ok'" class="viewer-block">
        <div class="row">
          <h3>Result</h3>
          <span :class="attempt.outcome.isError ? 'danger-text' : ''">
            {{ attempt.outcome.isError ? "error" : "ok" }}
          </span>
          <span class="muted">{{ formatDuration(attempt.outcome.durationMs) }}</span>
        </div>
        <Suspense>
          <component :is="AsyncJsonViewer" :value="attempt.outcome.data" />
          <template #fallback><p class="muted">Loading viewer…</p></template>
        </Suspense>
      </div>
      <div v-else class="viewer-block">
        <h3>Result</h3>
        <p class="warn-text">{{ attempt.outcome.message }}</p>
        <ul v-if="attempt.outcome.issues" class="warn-text issues">
          <li v-for="issue in attempt.outcome.issues" :key="issue">{{ issue }}</li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
h2 {
  font-size: 1.05rem;
}

h3 {
  font-size: 0.95rem;
}

.args-editor {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.85rem;
}

.issues {
  margin: 0;
  padding-left: 20px;
  display: grid;
  gap: 2px;
}

.attempt {
  display: grid;
  gap: 16px;
}

.viewer-block {
  display: grid;
  gap: 6px;
  min-width: 0;
}
</style>
