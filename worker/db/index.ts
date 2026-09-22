/**
 * The db layer's front door.
 *
 * `makeRepos(ctx)` is the one thing the rest of the Worker constructs. Repos are
 * plain objects of closures over a `Ctx`, so a request handler builds them once
 * per request and a scheduled run builds them once per invocation -- there is no
 * shared mutable state to get wrong, and a test can hand them a different clock.
 *
 * Nothing outside `worker/db/**` should import `crypto.ts` or touch a `*_enc`
 * column: the repos are what guarantee a sealed value is only ever opened with
 * the AAD it was sealed under.
 */

import { makeCtx } from "./client.ts";
import { makeAlertsRepo } from "./repos/alerts.ts";
import { makeCalendarEventsRepo } from "./repos/calendar-events.ts";
import { makeConnectionsRepo } from "./repos/connections.ts";
import { makeFhirCacheRepo } from "./repos/fhir-cache.ts";
import { makeFhirSyncStateRepo } from "./repos/fhir-sync-state.ts";
import { makeGoogleAccountRepo } from "./repos/google-account.ts";
import { makeLoginAttemptsRepo } from "./repos/login-attempts.ts";
import { makeMailInboxRepo } from "./repos/mail-inbox.ts";
import { makeMcpAuditRepo } from "./repos/mcp-audit.ts";
import { makeMcpPolicyRepo } from "./repos/mcp-policy.ts";
import { makeOAuthStatesRepo } from "./repos/oauth-states.ts";
import { makePortalAccountsRepo } from "./repos/portal-accounts.ts";
import { makeProvidersRepo } from "./repos/providers.ts";
import { makeRunLogRepo } from "./repos/run-log.ts";

import type { Ctx, CtxOptions } from "./client.ts";
import type { Env } from "../env.ts";

export function makeRepos(ctx: Ctx) {
  return {
    ctx,
    providers: makeProvidersRepo(ctx),
    connections: makeConnectionsRepo(ctx),
    google: makeGoogleAccountRepo(ctx),
    oauthStates: makeOAuthStatesRepo(ctx),
    fhirCache: makeFhirCacheRepo(ctx),
    fhirSyncState: makeFhirSyncStateRepo(ctx),
    calendarEvents: makeCalendarEventsRepo(ctx),
    alerts: makeAlertsRepo(ctx),
    mcpAudit: makeMcpAuditRepo(ctx),
    mcpPolicy: makeMcpPolicyRepo(ctx),
    runLog: makeRunLogRepo(ctx),
    loginAttempts: makeLoginAttemptsRepo(ctx),
    portalAccounts: makePortalAccountsRepo(ctx),
    mailInbox: makeMailInboxRepo(ctx),
  };
}

export type Repos = ReturnType<typeof makeRepos>;

/** Build a Ctx and its repos in one step. What a request handler calls. */
export function reposFor(db: D1Database, env: Env, options: CtxOptions = {}): Repos {
  return makeRepos(makeCtx(db, env, options));
}
