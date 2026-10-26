/**
Re-read one health system's patient-portal secure messages, now, and nothing
else.

The hourly run reads the Message Center at the end of the portal pass, after
the visit list, every visit's details page and the calendar. That is far more
than "did my care team answer the message I just sent?" needs, and the
scheduled pass is up to an hour away. This is the cheap read for that
question: one live session, the Message Center, its new attachments, done.

It is **synchronous**. The admin button and the MCP tool `refresh_messages`
both await it and answer once the store holds what the portal said, so the
next `get_messages` sees the new message. A Message Center read is seconds,
and neither caller is a `waitUntil`: the admin route is an awaited handler,
and a tool call runs inside its own Durable Object session.

What it never does:

 - **Sign in.** The session must already be live. A dead one answers
   `portal_session_expired` and marks nothing: re-establishing it is the
   schedule's job, under its own limits, or the owner's.
 - **Overlap a sign-in.** It holds the per-health-system sign-in gate
   (`portal-gate.ts`) for the length of the read. A sign-in seals a new
   cookie jar, and the read saves its own jar when it ends; without the gate
   the read could overwrite the new jar with the old one. A refresh that
   finds the gate taken answers `portal_signin_busy`, and two refreshes of
   one health system cannot run at once for the same reason. The scheduled
   pass does not take the gate for its own read, so a refresh during it is
   two reads of one live session; the later jar wins, and both are valid.
 - **Count towards the sync-failing alert.** See `syncMessages`'
   `countFailure`. Success still clears a streak, because it is true.

How often it may be asked is the caller's business: the MCP tool holds an
assistant to a token bucket (`worker/src/db/repos/mcp-message-refreshes.ts`),
and the owner's button is held to nothing but the gate.

Logs carry the health system id, counts and stable codes, as the portal pass
does. Never a subject, a body, a name or a byte of portal markup.
*/

import { makeRepos } from "../db/index.ts";
import { isAppError } from "../lib/errors.ts";
import { errorFields } from "../lib/log.ts";

import { SIGN_IN_BUSY_CODE, acquirePortalSignIn, releasePortalSignIn } from "./portal-gate.ts";
import { openPortalSession, portalDeps } from "./portal-signin.ts";
import { syncMessages } from "./portal-sync.ts";

import type { SyncDeps } from "./deps.ts";
import type { MessageRefreshResult, MessageRefreshSkip } from "./message-refresh-result.ts";
import type { Ctx } from "../db/client.ts";
import type { PortalAccountRow } from "../db/rows.ts";

/** The gate's holder name for a refresh, so a stuck lock says who took it. */
const GATE_HOLDER = "messages";

/** Why this account has nothing to read, or null when it may be read. */
function messageRefreshSkip(account: PortalAccountRow | null): MessageRefreshSkip | null {
  if (account === null) return "portal_not_configured";
  if (account.username_enc === null || account.password_enc === null) {
    return "portal_no_credentials";
  }
  if (account.session_state === "needs_reauth") return "portal_needs_reauth";
  return account.session_state === "active" ? null : "portal_not_signed_in";
}

/** The read itself, with the gate already held. */
async function readWithGate(
  ctx: Ctx,
  healthSystemId: string,
  deps: SyncDeps,
): Promise<MessageRefreshResult> {
  const repos = makeRepos(ctx);
  const opened = await openPortalSession(ctx, healthSystemId, portalDeps(deps));
  if (!(await opened.session.client.isSessionAlive())) {
    // Whatever the probe was answered with, kept: a refreshed cookie on it is
    // still the session's.
    await opened.session.persistJar();
    ctx.log.info("portal.messages_refresh_no_session", { healthSystemId });
    return { outcome: "failed", code: "portal_session_expired" };
  }
  const read = await syncMessages({ ctx, repos, deps }, healthSystemId, opened.session, {
    countFailure: false,
  });
  if (!read.ok) return { outcome: "failed", code: read.errorCode };
  return {
    outcome: "refreshed",
    threads: read.threads,
    messages: read.messages,
    written: read.written,
    complete: read.complete,
  };
}

/** Re-read one health system's Message Center now. Never signs in; never throws. */
export async function refreshPortalMessages(
  ctx: Ctx,
  options: { healthSystemId: string },
  deps: SyncDeps = {},
): Promise<MessageRefreshResult> {
  const { healthSystemId } = options;
  const started = Date.now();
  let result: MessageRefreshResult;
  try {
    const skip = messageRefreshSkip(await makeRepos(ctx).portalAccounts.get(healthSystemId));
    if (skip === null) {
      if (await acquirePortalSignIn(ctx, healthSystemId, GATE_HOLDER)) {
        try {
          result = await readWithGate(ctx, healthSystemId, deps);
        } finally {
          await releasePortalSignIn(ctx, healthSystemId);
        }
      } else {
        result = { outcome: "busy", code: SIGN_IN_BUSY_CODE };
      }
    } else {
      result = { outcome: "skipped", code: skip };
    }
  } catch (error) {
    ctx.log.warn("portal.messages_refresh_failed", { healthSystemId, ...errorFields(error) });
    result = { outcome: "failed", code: isAppError(error) ? error.code : "internal" };
  }
  ctx.log.info("portal.messages_refresh", {
    healthSystemId,
    outcome: result.outcome,
    ...("code" in result && { errorCode: result.code }),
    ...(result.outcome === "refreshed" && { messages: result.messages, written: result.written }),
    ms: Date.now() - started,
  });
  return result;
}
