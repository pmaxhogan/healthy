/**
`refresh_messages`: re-read one health system's patient-portal secure
messages now, and answer once they are stored.

The second tool on this server that acts, and the argument for it is the use
it serves: an assistant told "I just sent my care team a message" or "see if
they wrote back" needs the inbox as it is now, and `sync_health_systems`
cannot give it that -- its portal kind runs the whole portal pass (visits,
every visit's page, the calendar) in the background, and is held to one
request per half hour. This tool does only the Message Center read, waits for
it, and is held to a token bucket built for a conversation
(`worker/src/mcp/message-refresh.ts`): a few refreshes seconds apart, then
one every two minutes.

What holds it in:

 - **One health system per call**, named, never "all": the read is of one
   portal session.
 - **It never signs in.** A portal that is not signed in is `skipped` or
   answers `portal_session_expired`; only the owner signs in. See
   `worker/src/sync/portal-messages-refresh.ts`, which also holds the
   sign-in gate for the read.
 - **The bucket is durable and atomic** (`mcp_message_refreshes`), and a
   token is spent only on a refresh that can go ahead: one skipped for its
   account's state costs nothing, and one that found another refresh or a
   sign-in in progress is refunded.
 - **A health system the owner's policy denies cannot be named**, as with
   every other tool.

The item carries this app's own health system id and display name, fixed
vocabulary, counts and instants. Never a subject, a body or anything the
portal said.
*/

import { z } from "zod";

import { toIso } from "../../lib/time.ts";
import { jqArg } from "../args.ts";
import { selectHealthSystems } from "../collect.ts";
import { MESSAGE_REFRESH_LIMITS, bucketLevel, nextTokenAt } from "../message-refresh.ts";
import { respond, toolError } from "../respond.ts";
import { portalSkipCode } from "../sync-request.ts";

import { actionTool } from "./register.ts";

import type { MessageRefreshResult } from "../../sync/message-refresh-result.ts";
import type { HealthSystemInfo, ToolDeps } from "../deps.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const TOOL = "refresh_messages";

/** Said when the read finished: the store is current, read it now. */
const READ_NOW_WARNING = "messages_refreshed_read_get_messages_now";

const DESCRIPTION =
  "Re-read one health system's patient-portal secure messages right now, and " +
  "answer once they are stored, so the next get_messages, get_message_thread " +
  "or get_message_attachment sees the inbox as it is this minute. Use it when " +
  "the person says they just sent or are expecting a message ('look at the " +
  "message I just sent', 'did my doctor reply?') and the newest message " +
  "get_messages shows is older than that. Messages are otherwise re-read " +
  "hourly. It reads only the Message Center: not visits, not appointments, not " +
  "clinical data (sync_health_systems does those). " +
  "`healthSystem` is required: one health system's id, or a part of its name " +
  "that matches exactly one (list_health_systems gives both). It takes a few " +
  "seconds. It is rate limited per health system by a bucket of " +
  `${String(MESSAGE_REFRESH_LIMITS.capacity)} refreshes that refills one every ` +
  `${String(MESSAGE_REFRESH_LIMITS.refillSeconds / 60)} minutes, so a few in a row ` +
  "are fine during a conversation; do not call it in a loop to wait for a " +
  "reply, and when it is refused, wait for `nextAllowedAt`. It never signs in " +
  "to the portal: if the portal is not signed in it says so, and only the " +
  "owner can sign it in, from the admin UI. " +
  "One item: `outcome` is `refreshed` (read and stored: `changed` is how many " +
  "messages were new or changed, `threads` and `messages` the totals), " +
  "`refused` (`code` `rate_limited`; `nextAllowedAt` says when), `skipped` " +
  "(nothing this tool can read: `portal_not_configured`, " +
  "`portal_no_credentials`, `portal_needs_reauth`, `portal_not_signed_in`), " +
  "`busy` (`portal_signin_busy`: a sign-in or another refresh is in progress; " +
  "no refresh was spent, ask again in a minute) or `failed` " +
  "(`portal_session_expired` or another stable code; the messages stored " +
  "before are unchanged). `refreshesLeft` is how many more may be asked for " +
  "right now.";

const schema = z.strictObject({
  healthSystem: z
    .string()
    .min(1)
    .describe(
      "The one health system whose messages to re-read: its id, or a case-insensitive " +
        "part of its display name that matches no other.",
    ),
  ...jqArg(TOOL, "plain"),
});

/**
The one health system `named` means, or null. An exact id wins over a name
match; otherwise the name substring has to match exactly one.
*/
function pickOne(candidates: readonly HealthSystemInfo[], named: string): HealthSystemInfo | null {
  const needle = named.trim().toLowerCase();
  const byId = candidates.find((healthSystem) => healthSystem.id.toLowerCase() === needle);
  if (byId !== undefined) return byId;
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

type Outcome = MessageRefreshResult["outcome"] | "refused";

/** A token bought nothing when the refresh never reached the portal. */
function refundable(result: MessageRefreshResult): boolean {
  return result.outcome === "busy" || result.outcome === "skipped";
}

export function registerRefreshMessagesTool(server: McpServer, deps: ToolDeps): void {
  actionTool(server, deps, { name: TOOL, description: DESCRIPTION, schema }, async (args, run) => {
    // A health system the owner's policy denies is never selected, so it
    // cannot be refreshed from here either.
    const candidates = selectHealthSystems(await deps.healthSystems(), run.rules, [
      args.healthSystem,
    ]);
    const healthSystem = pickOne(candidates, args.healthSystem);
    if (healthSystem === null) {
      return toolError("invalid_health_system", {
        detail: `${String(candidates.length)} health systems matched`,
      });
    }
    const { id } = healthSystem;
    const limits = MESSAGE_REFRESH_LIMITS;

    let outcome: Outcome;
    let code: string;
    let result: MessageRefreshResult | null = null;
    const skip = portalSkipCode(healthSystem);
    if (skip !== null) {
      outcome = "skipped";
      code = skip;
    } else if (await deps.sync.takeMessageRefresh(id, limits)) {
      result = await deps.sync.refreshMessages(id);
      outcome = result.outcome;
      code = "code" in result ? result.code : "refreshed";
      if (refundable(result)) await deps.sync.refundMessageRefresh(id, limits);
    } else {
      outcome = "refused";
      code = "rate_limited";
    }

    // Read after the spend (or the refund), so the answer is the bucket as it
    // now stands. The clock is the server's; `run.now` is the call's start.
    const now = deps.now();
    const level = bucketLevel(await deps.sync.messageRefreshBucket(id), now, limits);
    const refreshesLeft = Math.floor(level);
    const refreshed = result?.outcome === "refreshed" ? result : null;

    deps.log.info("mcp.messages_refresh_requested", {
      healthSystemId: id,
      outcome,
      errorCode: code,
      refreshesLeft,
    });

    return respond({
      tool: TOOL,
      rules: run.rules,
      items: [
        {
          kind: "message_refresh",
          healthSystem: healthSystem.displayName,
          healthSystemId: id,
          outcome,
          code,
          changed: refreshed?.written ?? null,
          threads: refreshed?.threads ?? null,
          messages: refreshed?.messages ?? null,
          complete: refreshed?.complete ?? null,
          refreshesLeft,
          nextAllowedAt: refreshesLeft >= 1 ? null : toIso(nextTokenAt(level, now, limits)),
          capacity: limits.capacity,
          refillSeconds: limits.refillSeconds,
        },
      ],
      jq: args.jq,
      healthSystemIds: [id],
      warnings: refreshed === null ? [] : [READ_NOW_WARNING],
      now: run.now,
    });
  });
}
