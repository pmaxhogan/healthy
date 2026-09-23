<script setup lang="ts">
// "Try a tool": lets the owner call any MCP tool directly from the admin
// console and see exactly what an MCP client would see -- the same input
// schema validation, the same exposure policy, the same audit row (as the
// admin console, not an OAuth client; see worker/mcp/admin-call.ts).
//
// The argument editor and the request/result viewers all run CodeMirror 6,
// which styles itself by injecting a <style> tag on a browser with no
// `adoptedStyleSheets` support -- and that needs `'unsafe-inline'` in
// `style-src`. Rather than loosen this app's CSP, all three live in a second,
// tiny page (`MCP_SANDBOX_PATH`, see shared/mcp-sandbox.ts) with its own,
// narrower CSP that permits inline styles and nothing else this app's CSP does
// not already forbid twice over. This component embeds it as
// `sandbox="allow-scripts"` -- deliberately with no `allow-same-origin` -- so
// the loaded page gets a fresh opaque origin: no cookies, no session, and no
// ability to call `/api` itself. This component does the one authenticated
// call the frame asks for, and posts the answer back in.
//
// Every message crossing the frame boundary is validated twice: by identity
// (`event.source` compared against the frame's own `contentWindow`, since an
// opaque-origin frame's `event.origin` is the literal string "null" and
// useless for this) and by shape (`isSandboxOutboundMessage`), so a message
// from anywhere else, or one this version does not understand, is dropped
// rather than acted on. See SECURITY.md for the full picture.

import { onBeforeUnmount, onMounted, ref, watch } from "vue";

import { MCP_SANDBOX_PATH, isSandboxOutboundMessage } from "@shared/mcp-sandbox.ts";

import { ApiRequestError, errorMessage, isAuthRequired } from "../api/client.ts";
import { endpoints } from "../api/endpoints.ts";
import { buildArgsSkeleton } from "../lib/mcp-schema.ts";
import { useLoad } from "../lib/use-load.ts";

import StateBlock from "./StateBlock.vue";

import type { SandboxInboundMessage } from "@shared/mcp-sandbox.ts";
import type { McpToolSchemaDto } from "@shared/types.ts";

const schemas = useLoad((signal) => endpoints.mcpToolSchemas(signal));

const selectedName = ref("");
const frameEl = ref<HTMLIFrameElement | null>(null);
const frameReady = ref(false);

watch(
  () => schemas.data.value,
  (list) => {
    const names = new Set((list ?? []).map((tool) => tool.name));
    if (!names.has(selectedName.value)) selectedName.value = list?.[0]?.name ?? "";
  },
  { immediate: true },
);

function findSelectedTool(): McpToolSchemaDto | null {
  return (schemas.data.value ?? []).find((tool) => tool.name === selectedName.value) ?? null;
}

function postToFrame(message: SandboxInboundMessage): void {
  // "*", not this origin: the sandboxed frame has an opaque origin (no
  // `allow-same-origin`), which cannot be named as a target origin at all.
  // eslint-disable-next-line sonarjs/post-message -- see above; there is no origin string a sandboxed, opaque-origin frame could be addressed by.
  frameEl.value?.contentWindow?.postMessage(message, "*");
}

function sendCurrentTool(): void {
  const tool = findSelectedTool();
  if (tool === null || !frameReady.value) return;
  postToFrame({
    type: "tool",
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    skeleton: buildArgsSkeleton(tool.inputSchema),
  });
}

watch(selectedName, sendCurrentTool);

/**
 * Runs one tool call on the frame's behalf and posts the answer back.
 *
 * `name` is checked against the current selection again once the call
 * settles, and a stale answer is dropped rather than delivered: the frame
 * resets to a new tool's schema the moment the owner switches, and a response
 * for the tool they switched away from has nowhere correct to land there
 * any more.
 */
async function handleRun(name: string, args: Record<string, unknown>): Promise<void> {
  const isStillSelected = (): boolean => name === selectedName.value;
  try {
    const response = await endpoints.callMcpTool(name, args);
    if (!isStillSelected()) return;
    postToFrame({
      type: "result",
      isError: response.result.isError,
      data: response.result.data,
      durationMs: response.durationMs,
    });
  } catch (error) {
    if (isAuthRequired(error) || !isStillSelected()) return;
    const issues =
      error instanceof ApiRequestError && Array.isArray(error.details?.issues)
        ? (error.details.issues as string[])
        : undefined;
    // The bare sentence, not `errorMessage(error)`: that helper also appends a
    // reformatted `details.issues` (tuned for a validation error's `path: rule`
    // shape), and an MCP schema rejection's one issue is the SDK's own full
    // sentence -- showing it once, verbatim, in the frame's issues list is
    // clearer than folding a mangled copy into the message too.
    const message =
      issues !== undefined && error instanceof ApiRequestError
        ? error.message
        : errorMessage(error);
    postToFrame({ type: "call-error", message, ...(issues && { issues }) });
  }
}

/**
 * The identity check that stands in for an origin check.
 *
 * An opaque-origin frame's `event.origin` is the literal string `"null"` on
 * every message it sends, which cannot distinguish this frame's messages from
 * any other opaque-origin frame's -- so this compares `event.source` (the
 * actual window that called `postMessage`) against this frame's own
 * `contentWindow` instead. `sonarjs/post-message`'s "verify the origin" advice
 * assumes origin comparison is possible; here it is not, and this is the
 * correct replacement for it.
 */
function isFromOurFrame(event: MessageEvent): boolean {
  // eslint-disable-next-line sonarjs/different-types-comparison -- MessageEventSource and Window overlap at runtime (a WindowProxy is both); this is exactly the comparison that matters here.
  return event.source === frameEl.value?.contentWindow;
}

function onWindowMessage(event: MessageEvent): void {
  if (!isFromOurFrame(event) || !isSandboxOutboundMessage(event.data)) return;
  const message = event.data;
  switch (message.type) {
    case "ready": {
      frameReady.value = true;
      sendCurrentTool();
      break;
    }
    case "run": {
      void handleRun(message.name, message.arguments);
      break;
    }
  }
}

onMounted(() => {
  // eslint-disable-next-line sonarjs/post-message -- see isFromOurFrame: an opaque-origin frame's event.origin is always "null", so identity on event.source is the verification, not an origin string.
  window.addEventListener("message", onWindowMessage);
});

onBeforeUnmount(() => {
  window.removeEventListener("message", onWindowMessage);
});
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
    </StateBlock>

    <iframe
      ref="frameEl"
      :src="MCP_SANDBOX_PATH"
      sandbox="allow-scripts"
      title="Tool arguments and result"
      class="sandbox-frame"
    />
  </section>
</template>

<style scoped>
h2 {
  font-size: 1.05rem;
}

.sandbox-frame {
  width: 100%;
  height: 720px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-input);
}
</style>
