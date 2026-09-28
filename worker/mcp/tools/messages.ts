/**
 * `get_messages` and `get_message_thread`: the patient portals' secure messages.
 *
 * Every conversation in every Message Center folder of every connected health
 * system's portal, as the portal pass last stored them. `get_messages` lists
 * the conversations, one item each with a preview of its newest message;
 * `get_message_thread` answers one conversation with every message in full.
 *
 * Both read the same per-message items (`worker/mcp/message-items.ts` explains
 * the dedupe and the policy), which `respond()` filters one message at a time
 * and only then groups (`worker/mcp/message-threads.ts`).
 *
 * Nothing here talks to a portal: like every tool but `get_document_text`, these
 * read only what the scheduled sync stored.
 */

import { z } from "zod";

import { jqArg, toolArgs, windowArgs } from "../args.ts";
import { effectiveLimit, selectHealthSystems } from "../collect.ts";
import { attachmentItem, findAttachment, imageReleased } from "../message-attachment.ts";
import { collectMessages, messageCoverage } from "../message-items.ts";
import { threadsReshape } from "../message-threads.ts";
import { respond } from "../respond.ts";

import { readTool } from "./register.ts";

import type { PolicyRules } from "../../policy/rules.ts";
import type { SharedArgs } from "../args.ts";
import type { ToolDeps } from "../deps.ts";
import type { MessageFilters } from "../message-items.ts";
import type { ThreadView } from "../message-threads.ts";
import type { ToolOutcome } from "../respond.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Told to a caller who asked for `raw`: a message has no FHIR resource behind it. */
const NO_RAW_WARNING = "messages_have_no_raw";

/** The longest search text accepted. A bound on the argument, not on the data. */
const SEARCH_MAX_LENGTH = 200;

const FOLDER = z
  .enum(["conversations", "appointments", "automated", "archive", "bookmarked"])
  .optional()
  .describe(
    "Only one Message Center folder: conversations (with the care team), " +
      "appointments, automated (letters and notices the portal sent on its own), " +
      "archive or bookmarked.",
  );

const SEARCH = z
  .string()
  .min(1)
  .max(SEARCH_MAX_LENGTH)
  .optional()
  .describe(
    "Only conversations whose subject or any message's full text contains this, " +
      "ignoring case and spacing. Searches every message, not just the preview.",
  );

const THREAD_ID = z
  .string()
  .min(1)
  .max(64)
  .describe("A `threadId` exactly as a get_messages item reported it.");

const MESSAGE_ARGS = toolArgs({
  ...windowArgs("newest message (`lastMessageAt`)"),
  ...jqArg("get_messages"),
  folder: FOLDER,
  search: SEARCH,
});

const THREAD_ARGS = toolArgs({ threadId: THREAD_ID, ...jqArg("get_message_thread") });

const ATTACHMENT_TOOL = "get_message_attachment";

const ATTACHMENT_ARGS = toolArgs({
  attachmentId: z
    .string()
    .min(1)
    .max(64)
    .describe(
      "An attachment's `id` exactly as a get_message_thread message's `attachments[]` reported it.",
    ),
  ...jqArg(ATTACHMENT_TOOL),
});

/** One attachment's file: find it among the messages the caller may see, read it, respond. */
async function attachmentAnswer(
  deps: ToolDeps,
  run: { rules: PolicyRules; now: number },
  args: SharedArgs & { attachmentId: string },
): Promise<ToolOutcome> {
  const all = await deps.healthSystems();
  const selected = selectHealthSystems(all, run.rules, args.healthSystems);
  const collected = await collectMessages(deps, all, selected, run.rules, {});
  const coverage = await messageCoverage(deps, selected, run.rules, run.now);
  const found = findAttachment(collected, args.attachmentId);
  const healthSystemId = found?.message.healthSystemId;
  const stored = found?.attachment.status === "stored";
  const bytes =
    stored && typeof healthSystemId === "string"
      ? await deps.portalAttachmentContent(healthSystemId, args.attachmentId)
      : null;
  const built = found === null ? null : attachmentItem(found, bytes);
  const outcome = await respond({
    tool: ATTACHMENT_TOOL,
    rules: run.rules,
    items: built === null ? [] : [built.item],
    sources: found === null ? [] : [found.source],
    limit: effectiveLimit(args.limit),
    jq: args.jq,
    healthSystemIds: collected.healthSystemIds,
    warnings: [
      ...(args.raw === true ? [NO_RAW_WARNING] : []),
      ...(found === null ? ["attachment_not_found"] : []),
    ],
    coverage,
    now: run.now,
  });
  const image = built?.image ?? null;
  if (image === null || outcome.errorCode !== null) return outcome;
  if (built === null || !imageReleased(ATTACHMENT_TOOL, run.rules, built.item, found?.source)) {
    return outcome;
  }
  return {
    ...outcome,
    result: {
      ...outcome.result,
      content: [
        ...outcome.result.content,
        { type: "image", data: image.data, mimeType: image.mimeType },
      ],
    },
  };
}

/** Shared by both tools: select, collect, cover, respond, grouped by conversation. */
async function answer(
  deps: ToolDeps,
  tool: string,
  run: { rules: PolicyRules; now: number },
  shared: SharedArgs,
  filters: MessageFilters,
  view: ThreadView,
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
    reshape: threadsReshape(view),
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
        "Patient-portal secure messages, one item per conversation (thread), newest " +
        "activity first: every conversation with a care team, and every letter and " +
        "notice, from every Message Center folder of every connected health system's " +
        "patient portal. Each item has `threadId`, `subject`, `folder`, " +
        "`firstMessageAt`/`lastMessageAt`, `messageCount`, `unreadCount`, " +
        "`attachmentCount`, the care team (`practitioners`), everyone who wrote in it " +
        "(`participants`, each with a `role`: patient, proxy, practitioner or " +
        "system), and `lastMessage`: the newest message's sender, time, direction " +
        "and a `preview` -- only its first 160 characters, `previewTruncated` saying " +
        "when there is more. For every message in full, pass the `threadId` to " +
        "get_message_thread. A conversation two health systems' portals both show is " +
        "answered once, from the health system whose own conversation it is " +
        "(`firstParty: true`); one only another organisation's portal shows is kept " +
        "with `firstParty: false` and `via`. Filter with `from`/`to` (on " +
        "`lastMessageAt`), `folder`, or `search` (subject and full message text). " +
        "Check `coverage` before concluding a message does not exist.",
      schema: MESSAGE_ARGS,
    },
    async (args, run) =>
      answer(
        deps,
        "get_messages",
        run,
        args,
        { from: args.from, to: args.to, folder: args.folder },
        { detail: false, search: args.search },
      ),
  );

  readTool(
    server,
    deps,
    {
      name: "get_message_thread",
      description:
        "One patient-portal conversation with every message in full, oldest first: " +
        "pass a `threadId` from get_messages. The item carries the conversation's " +
        "own fields (subject, folder, dates, counts, care team, participants) and " +
        "`messages`, each with `id`, `sent`, `direction` (from_patient or " +
        "to_patient), `from` (`role`, and the name where the owner's rules allow), " +
        "`unread`, the full `body` as plain text, and `attachments`. In the rare case " +
        "one conversation's messages come from two health systems' portals, there is " +
        "one item per health system.",
      schema: THREAD_ARGS,
    },
    async (args, run) =>
      answer(deps, "get_message_thread", run, args, { threadId: args.threadId }, { detail: true }),
  );

  readTool(
    server,
    deps,
    {
      name: ATTACHMENT_TOOL,
      description:
        "The file attached to a patient-portal secure message: pass an attachment `id` " +
        "from get_message_thread (`messages[].attachments[].id`). Read from what the " +
        "hourly portal pass fetched and stored -- never fetched now. The item has the " +
        "file's `name`, `contentType`, `size` and `status`: `stored`, `failed` (the " +
        "portal would not serve it; `errorCode` says how), `waiting_until_read` (its " +
        "message is still unread in the portal, so it has not been fetched) or " +
        "`not_fetched`. A stored text file (plain text, HTML, RTF) comes back as " +
        "`text`; a stored image (PNG, JPEG, GIF, WebP) comes back as an image content " +
        "block beside the item; any other type (PDF, TIFF) comes back as its type and " +
        "size with a `note` -- its content cannot be returned here.",
      schema: ATTACHMENT_ARGS,
    },
    async (args, run) => attachmentAnswer(deps, run, args),
  );
}
