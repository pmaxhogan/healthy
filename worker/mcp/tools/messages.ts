/**
 * `get_messages` and `get_message_thread`: the patient portals' secure messages.
 *
 * Every conversation in every Message Center folder of every connected health
 * system's portal, every message in each, as the portal pass last stored them
 * (`worker/mcp/message-items.ts` explains the dedupe and the policy). One item per
 * message; a thread is the items that share a `threadId`.
 *
 * Nothing here talks to a portal: like every tool but `get_document_text`, these
 * read only what the scheduled sync stored.
 */

import { z } from "zod";

import { jqArg, toolArgs, windowArgs } from "../args.ts";
import { effectiveLimit, selectHealthSystems } from "../collect.ts";
import { collectMessages, messageCoverage } from "../message-items.ts";
import { respond } from "../respond.ts";

import { readTool } from "./register.ts";

import type { PolicyRules } from "../../policy/rules.ts";
import type { SharedArgs } from "../args.ts";
import type { ToolDeps } from "../deps.ts";
import type { MessageFilters } from "../message-items.ts";
import type { ToolOutcome } from "../respond.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Told to a caller who asked for `raw`: a message has no FHIR resource behind it. */
const NO_RAW_WARNING = "messages_have_no_raw";

const FOLDER = z
  .enum(["conversations", "appointments", "automated", "archive", "bookmarked"])
  .optional()
  .describe(
    "Only one Message Center folder: conversations (with the care team), " +
      "appointments, automated (letters and notices the portal sent on its own), " +
      "archive or bookmarked.",
  );

const DIRECTION = z
  .enum(["from_patient", "to_patient"])
  .optional()
  .describe("Only messages the patient sent (from_patient) or received (to_patient).");

const THREAD_ID = z
  .string()
  .min(1)
  .max(64)
  .describe("A `threadId` exactly as a get_messages item reported it.");

const MESSAGE_ARGS = toolArgs({
  ...windowArgs("`sent`"),
  ...jqArg("get_messages"),
  threadId: THREAD_ID.optional(),
  folder: FOLDER,
  direction: DIRECTION,
});

const THREAD_ARGS = toolArgs({ threadId: THREAD_ID, ...jqArg("get_message_thread") });

/** Shared by both tools: select, collect, cover, respond. */
async function answer(
  deps: ToolDeps,
  tool: string,
  run: { rules: PolicyRules; now: number },
  shared: SharedArgs,
  filters: MessageFilters,
): Promise<ToolOutcome> {
  const all = await deps.healthSystems();
  const selected = selectHealthSystems(all, run.rules, shared.healthSystems);
  const collected = await collectMessages(deps, all, selected, run.rules, filters);
  const coverage = await messageCoverage(deps, selected, run.rules, run.now);
  return respond({
    tool,
    rules: run.rules,
    items: collected.items,
    sources: collected.sources,
    limit: effectiveLimit(shared.limit),
    jq: shared.jq,
    healthSystemIds: collected.healthSystemIds,
    warnings: [
      ...(shared.raw === true ? [NO_RAW_WARNING] : []),
      ...(filters.threadId !== undefined && collected.items.length === 0
        ? ["thread_not_found"]
        : []),
    ],
    coverage,
    now: run.now,
  });
}

export function registerMessageTools(server: McpServer, deps: ToolDeps): void {
  readTool(
    server,
    deps,
    {
      name: "get_messages",
      description:
        "Patient-portal secure messages: every conversation with a care team, " +
        "every message in each, from every Message Center folder (conversations, " +
        "appointments, automated letters and notices, archive, bookmarked) of every " +
        "connected health system's patient portal. One item per message, newest " +
        "first: `sent`, `subject`, `direction` (from_patient or to_patient), " +
        "`from.role` (patient, proxy, practitioner or system), the `body` as plain " +
        "text, and attachment names. Items with the same `threadId` are one " +
        "conversation; get_message_thread returns one in order. A message two " +
        "health systems' portals both show is answered once, from the health " +
        "system whose own conversation it is (`firstParty: true`); a copy only " +
        "another organisation's portal shows is kept with `firstParty: false` and " +
        "`via`. Filter with `from`/`to` (on `sent`), `folder`, `direction` or " +
        "`threadId`, and search with `jq`, e.g. " +
        '`.[] | select(.body | test("refill"; "i")) | {sent, subject, body}`. ' +
        "Check `coverage` before concluding a message does not exist.",
      schema: MESSAGE_ARGS,
    },
    async (args, run) =>
      answer(deps, "get_messages", run, args, {
        from: args.from,
        to: args.to,
        threadId: args.threadId,
        folder: args.folder,
        direction: args.direction,
        order: "desc",
      }),
  );

  readTool(
    server,
    deps,
    {
      name: "get_message_thread",
      description:
        "One patient-portal conversation, every message in it, oldest first: pass " +
        "a `threadId` from get_messages. Same item shape as get_messages.",
      schema: THREAD_ARGS,
    },
    async (args, run) =>
      answer(deps, "get_message_thread", run, args, { threadId: args.threadId, order: "asc" }),
  );
}
