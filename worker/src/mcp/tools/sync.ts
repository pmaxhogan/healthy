/**
 * `sync_health_systems`: the one tool on this server that acts.
 *
 * Every other tool reads what the last sync cached. This one asks the sync
 * engine for a run now: the ordinary sync, a full refresh, or the
 * patient-portal pass, for the health systems the caller names. It answers at
 * once -- the run happens afterwards, on a Durable Object alarm -- with one row
 * per health system saying what was started, what was not, and why.
 *
 * The caller is a language model, so the tool is built to be hard to misuse:
 *
 *  - **Nothing is implied.** `kind` has no default, so the expensive full
 *    refresh is never what a bare call means, and the target is either named
 *    health systems or a literal `all: true`, never "everything, since you did
 *    not say".
 *  - **Every request is judged before anything starts** by
 *    `worker/src/mcp/sync-request.ts`: is there anything to sync, is a health
 *    system rate limiting this app, is a run already in flight, is the data
 *    already fresh, and has this been asked for too recently or too often.
 *  - **The cooldown is durable and atomic.** It is a row in `mcp_sync_requests`
 *    claimed by one SQL statement, so it holds across sessions and two calls
 *    arriving together cannot both win.
 *  - **It cannot sign in to a patient portal.** See `sync-request.ts` and
 *    `worker/src/sync/runner.ts`.
 *  - **`dryRun` shows the verdict and starts nothing**, so an assistant can
 *    look before it asks.
 *
 * A row carries this app's own health system id and display name (as every
 * tool's rows do), fixed vocabulary and instants. No URL, login, token, portal
 * identifier or upstream message is read here, so none can be answered or
 * logged. The log line per health system is an id, the kind and two stable
 * codes.
 */

import { z } from "zod";

import { toIso } from "../../lib/time.ts";
import { jqArg } from "../args.ts";
import { selectHealthSystems } from "../collect.ts";
import { respond, toolError } from "../respond.ts";
import {
  SYNC_KINDS,
  decideSync,
  lastCompletedAt,
  requestsToday,
  syncLimits,
} from "../sync-request.ts";

import { actionTool } from "./register.ts";

import type { McpSyncKind, McpSyncRequestEntry } from "../../db/rows.ts";
import type { HealthSystemInfo, ToolDeps } from "../deps.ts";
import type { SyncCode, SyncFacts, SyncOutcome } from "../sync-request.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const TOOL = "sync_health_systems";

/** Said when a dry run was asked for: nothing below was started. */
const DRY_RUN_WARNING = "dry_run_nothing_was_started";
/** Said when anything started: the answer is not the result of the sync. */
const BACKGROUND_WARNING = "sync_runs_in_background_read_get_sync_status_later";
/** Said when the target named nothing this caller can see. */
const NO_MATCH_WARNING = "no_health_system_matched";

const DESCRIPTION =
  "Ask this server to sync health systems now instead of waiting for its " +
  "schedule. This is the only tool here that acts; every other tool reads what " +
  "the last sync cached. You rarely need it: the record is already synced on a " +
  "schedule (appointments hourly, every resource type every four hours, the " +
  "patient portal hourly), and every answer's `coverage` and `warnings`, and " +
  "get_sync_status, say how fresh each part is. Call it only when the person " +
  "asks for a refresh, or when `coverage` shows that something they need is " +
  "stale or failed. Do NOT call it before a read as a matter of course, do not " +
  "call it in a loop, do not call it to find out whether an earlier sync has " +
  "finished (read get_sync_status), and do not repeat a refused request before " +
  "its `nextAllowedAt`. " +
  "`kind` is required: `ordinary` is the hourly sync (upcoming and recent " +
  "appointments from the health system's API, plus the patient portal's visits " +
  "and secure messages when its session is already signed in); `full` re-reads " +
  "every resource type (conditions, medications, results, documents and the " +
  "rest) and is the expensive one, so ask for it only when a non-appointment " +
  "type is stale; `portal` is the patient-portal pass alone (upcoming visits " +
  "and secure messages). No kind ever signs in to a portal: one that is not " +
  "signed in is skipped, and only the owner can sign it in, from the admin UI. " +
  "Say which health systems: `healthSystems` (ids or name substrings, as " +
  "list_health_systems gives them) or `all: true` for every one -- exactly one " +
  "of the two, there is no default. `dryRun: true` starts nothing and reports " +
  "what would happen, including every cooldown. " +
  "It answers at once; the sync runs in the background and takes from seconds " +
  "to several minutes, so read the data again later rather than straight away. " +
  "One item per health system: `outcome` is `started`, `would_start` (dry " +
  "run), `already_running` (a run that covers it is in flight), `refused` (a " +
  "limit; `nextAllowedAt` says when to ask again), `skipped` (nothing this " +
  "tool can sync there) or `failed`. `code` says why: `cooldown`, " +
  "`daily_limit`, `recently_synced`, `backed_off` (a health system asked this " +
  "server to slow down), `run_in_flight`, `full_refresh_in_flight`, " +
  "`portal_sign_in_in_flight`, `disabled`, `not_connected`, `needs_reauth`, " +
  "`portal_not_configured`, `portal_no_credentials`, `portal_needs_reauth`, " +
  "`portal_not_signed_in`, `start_failed`. Each item also carries " +
  "`lastCompletedAt` (when a sync of that kind last finished, by any trigger), " +
  "`lastRequestedAt`, `requestsToday`, `dailyLimit` and `cooldownSeconds`.";

const schema = z.strictObject({
  healthSystems: z
    .array(z.string().min(1))
    .min(1)
    .max(20)
    .optional()
    .describe(
      "The health systems to sync: ids, or case-insensitive substrings of display " +
        "names. Give this or `all: true`, not both and not neither.",
    ),
  all: z
    .boolean()
    .optional()
    .describe(
      "Pass `true` to mean every health system, instead of naming them. There is no " +
        "default: a call that names none and does not pass `all: true` is refused.",
    ),
  kind: z
    .enum(SYNC_KINDS)
    .describe(
      "Which sync. `ordinary`: appointments from the API and, where a portal is " +
        "already signed in, its visits and messages. `full`: every resource type; " +
        "expensive, at most once every four hours per health system. `portal`: the " +
        "patient-portal pass alone. Required; there is no default.",
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "Start nothing; report per health system whether the request would start, be " +
        "refused or be skipped, and when a refused one may be asked again.",
    ),
  ...jqArg(TOOL, "plain"),
});

/** One health system's result, as it is being worked out. */
interface Row {
  healthSystem: HealthSystemInfo;
  outcome: SyncOutcome | "ready";
  code: SyncCode;
  /** Unix seconds. */
  nextAllowedAt: number | null;
  /** True once this call has taken the cooldown slot for it. */
  claimed: boolean;
}

/** The ids, of `healthSystems`, for which `probe` answers true. */
async function idsWhere(
  healthSystems: readonly HealthSystemInfo[],
  probe: (healthSystemId: string) => Promise<boolean>,
): Promise<Set<string>> {
  const answers = await Promise.all(
    healthSystems.map(async (healthSystem) => ({
      id: healthSystem.id,
      yes: await probe(healthSystem.id),
    })),
  );
  return new Set(answers.filter((answer) => answer.yes).map((answer) => answer.id));
}

/** Everything the decision reads, gathered once for the whole call. */
async function gatherFacts(
  deps: ToolDeps,
  kind: McpSyncKind,
  healthSystems: readonly HealthSystemInfo[],
  now: number,
): Promise<SyncFacts> {
  const withPortal = healthSystems.filter((healthSystem) => healthSystem.portal !== null);
  const [backoffUntil, runInFlight, history, fullRefreshInFlight, portalSignInInFlight] =
    await Promise.all([
      deps.sync.backoffUntil(),
      deps.sync.runInFlight(),
      deps.sync.history(kind),
      // A full refresh does not touch the portal, and the portal pass does not
      // touch the API: each kind asks only about what it would collide with.
      kind === "portal"
        ? new Set<string>()
        : idsWhere(healthSystems, (id) => deps.sync.fullRefreshInFlight(id)),
      kind === "full"
        ? new Set<string>()
        : idsWhere(withPortal, (id) => deps.sync.portalSignInInFlight(id)),
    ]);
  return {
    now,
    backoffUntil,
    runInFlight,
    fullRefreshInFlight,
    portalSignInInFlight,
    history: new Map(history.map((entry) => [entry.healthSystemId, entry])),
  };
}

/**
 * Take the cooldown slot for every row that is ready.
 *
 * A row that loses the slot here was beaten to it by a call that arrived at
 * the same moment, which is the case the single-statement claim exists for.
 */
async function claimReady(
  deps: ToolDeps,
  kind: McpSyncKind,
  rows: readonly Row[],
  now: number,
): Promise<void> {
  const limits = syncLimits(kind);
  for (const row of rows) {
    if (row.outcome !== "ready") continue;
    if (await deps.sync.claim(row.healthSystem.id, kind, limits)) {
      row.claimed = true;
      continue;
    }
    row.outcome = "refused";
    row.code = "cooldown";
    row.nextAllowedAt = now + limits.cooldownSeconds;
  }
}

function markStarted(row: Row, started: boolean, busy: SyncCode): void {
  row.outcome = started ? "started" : "already_running";
  row.code = started ? "started" : busy;
}

function markFailed(deps: ToolDeps, rows: readonly Row[]): void {
  for (const row of rows) {
    row.outcome = "failed";
    row.code = "start_failed";
  }
  // The code only: what was thrown may quote something, and is not logged.
  deps.log.warn("mcp.sync_start_failed", { tool: TOOL, healthSystems: rows.length });
}

/**
 * Queue the runs for the rows that hold a slot.
 *
 * A full refresh is one job per health system, as the admin button queues it.
 * The other two kinds are ONE calendar run over every claimed health system:
 * the run decides between two organisations' copies of one visit, which it can
 * only do when it sees them together. A slot stays taken when its start fails
 * or finds a run already queued; the caller waits out the cooldown, which is
 * the cautious reading of "something is wrong or already happening".
 */
async function startClaimed(
  deps: ToolDeps,
  kind: McpSyncKind,
  rows: readonly Row[],
): Promise<void> {
  const claimed = rows.filter((row) => row.claimed);
  if (claimed.length === 0) return;

  if (kind === "full") {
    for (const row of claimed) {
      try {
        const { started } = await deps.sync.startFullRefresh(row.healthSystem.id);
        markStarted(row, started, "full_refresh_in_flight");
      } catch {
        markFailed(deps, [row]);
      }
    }
    return;
  }

  try {
    const { started } = await deps.sync.startCalendarSync(
      claimed.map((row) => row.healthSystem.id),
      { portalOnly: kind === "portal" },
    );
    for (const row of claimed) markStarted(row, started, "run_in_flight");
  } catch {
    markFailed(deps, claimed);
  }
}

/** A unix-second instant as ISO, or null. */
function iso(seconds: number | null): string | null {
  return seconds === null ? null : toIso(seconds);
}

/** The row as the caller reads it. */
function toItem(
  row: Row,
  kind: McpSyncKind,
  entry: McpSyncRequestEntry | undefined,
  now: number,
): Record<string, unknown> {
  const limits = syncLimits(kind);
  const { healthSystem } = row;
  // A row this call claimed has a new last request: this one.
  const lastRequestedAt = row.claimed ? now : (entry?.requestedAt ?? null);
  const nextAllowedAt =
    row.outcome === "started" ? now + limits.cooldownSeconds : row.nextAllowedAt;
  return {
    kind: "sync_request",
    healthSystem: healthSystem.displayName,
    healthSystemId: healthSystem.id,
    sync: kind,
    outcome: row.outcome === "ready" ? "would_start" : row.outcome,
    code: row.outcome === "ready" ? "dry_run" : row.code,
    nextAllowedAt: iso(nextAllowedAt),
    lastCompletedAt: iso(lastCompletedAt(kind, healthSystem)),
    lastRequestedAt: iso(lastRequestedAt),
    requestsToday: requestsToday(entry, now) + (row.claimed ? 1 : 0),
    dailyLimit: limits.dailyLimit,
    cooldownSeconds: limits.cooldownSeconds,
  };
}

function warningsFor(rows: readonly Row[], dryRun: boolean): string[] {
  const warnings: string[] = [];
  if (rows.length === 0) warnings.push(NO_MATCH_WARNING);
  if (dryRun) warnings.push(DRY_RUN_WARNING);
  if (rows.some((row) => row.outcome === "started")) warnings.push(BACKGROUND_WARNING);
  return warnings;
}

export function registerSyncTool(server: McpServer, deps: ToolDeps): void {
  actionTool(server, deps, { name: TOOL, description: DESCRIPTION, schema }, async (args, run) => {
    const named = args.healthSystems ?? [];
    const all = args.all === true;
    const namedSome = named.length > 0;
    // Exactly one way of saying which. Neither is not "all of them", and both
    // is a caller who has not decided.
    if (all === namedSome) return toolError("invalid_target");

    // A health system the owner's policy denies is never selected, by name or
    // by `all`, so it cannot be synced from here either.
    const healthSystems = selectHealthSystems(
      await deps.healthSystems(),
      run.rules,
      all ? undefined : named,
    );
    const { kind } = args;
    const dryRun = args.dryRun === true;

    const facts = await gatherFacts(deps, kind, healthSystems, run.now);
    const rows: Row[] = healthSystems.map((healthSystem) => ({
      healthSystem,
      ...decideSync(kind, healthSystem, facts),
      claimed: false,
    }));

    if (!dryRun) {
      await claimReady(deps, kind, rows, run.now);
      await startClaimed(deps, kind, rows);
    }

    const items = rows.map((row) => {
      const item = toItem(row, kind, facts.history.get(row.healthSystem.id), run.now);
      deps.log.info("mcp.sync_requested", {
        healthSystemId: row.healthSystem.id,
        sync: kind,
        outcome: item.outcome,
        errorCode: item.code,
        dryRun,
      });
      return item;
    });

    return respond({
      tool: TOOL,
      rules: run.rules,
      items,
      jq: args.jq,
      healthSystemIds: healthSystems.map((healthSystem) => healthSystem.id),
      warnings: warningsFor(rows, dryRun),
      now: run.now,
    });
  });
}
