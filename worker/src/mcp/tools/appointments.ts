/**
 * `get_appointments`.
 *
 * Separate from the other clinical tools for two reasons. It projects rather than
 * returns the normalized shape -- `appointmentViewFromEncounter` is the flat
 * "when, where, who, what" view that a calendar or a reminder actually needs, and
 * it is the same projection the Google Calendar sync maps from, so the MCP and the
 * calendar cannot drift. And its default window is not "everything": an
 * appointments question is almost always about what is coming up, so the lower
 * bound defaults to now unless the caller asks for history.
 *
 * The projected item is tagged `resourceType: "Encounter"` even though the
 * projection has no resourceType of its own. Without it a `resource` deny rule on
 * Encounter would hide `get_encounters` and leave this tool serving the same
 * visits under another name.
 *
 * Upcoming visits come from the patient portal, not from FHIR: Epic's patient
 * view never returns an Encounter before it happens. `collectAppointments`
 * merges the portal pass's stored visits in, one item per visit, each marked
 * `source: "fhir" | "portal"` -- see `worker/src/mcp/appointment-items.ts`, which
 * also explains why a portal item's `raw` is only a placeholder.
 *
 * Ordering: the default (upcoming-only) window is soonest first, because "what
 * is next" is the question and a far-future visit must not push next week's off
 * the page. A window that reaches into the past -- `includePast` or an explicit
 * `from` -- is newest first, like every other tool. There is no default upper
 * bound: every upcoming visit the portal lists is returned, however far out.
 */

import { z } from "zod";

import { collectAppointments } from "../appointment-items.ts";
import { jqArg, toolArgs, windowArgs } from "../args.ts";
import { deniedHealthSystems, effectiveLimit, selectHealthSystems } from "../collect.ts";
import { buildCoverage, mergeCoverage } from "../coverage.ts";
import { respond } from "../respond.ts";

import { readTool } from "./register.ts";

import type { CoverageEntry } from "../coverage.ts";
import type { HealthSystemInfo, PortalAccountInfo, ToolDeps } from "../deps.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** How long since the portal last answered a signed-in read before its visits are
 * called `stale` rather than `ok`. The sync runs hourly and the keepalive every
 * ten minutes; six hours gives several missed runs of slack before flagging. */
const PORTAL_STALE_AFTER_SECONDS = 6 * 60 * 60;

/**
 * A synthetic coverage entry per health system for the portal half of
 * `get_appointments`: upcoming visits come only from the patient portal (see
 * `worker/src/mcp/appointment-items.ts`), so the portal account's own state
 * (`HealthSystemInfo.portal`: signed in or not, when it last answered, its last
 * error) is what says whether they are current. A health system with no portal
 * account reports `unsupported`. It is reported under a resource type of its
 * own, `PortalVisit`, rather than folded into `Encounter`.
 */
function portalCoverage(healthSystems: readonly HealthSystemInfo[], now: number): CoverageEntry[] {
  return healthSystems.map((healthSystem) => ({
    healthSystemId: healthSystem.id,
    healthSystem: healthSystem.displayName,
    resourceType: "PortalVisit",
    ...portalCoverageOf(healthSystem.portal, now),
  }));
}

/**
 * One health system's portal coverage, from the portal account's own state.
 *
 * Never from the FHIR connection: a portal-only health system has none, and a
 * FHIR grant that needs re-authorising says nothing about the portal session.
 */
function portalCoverageOf(
  portal: PortalAccountInfo | null,
  now: number,
): Pick<CoverageEntry, "status" | "errorCode" | "ageHours"> {
  // No portal account: this health system's visits come from FHIR alone.
  if (portal === null) return { status: "unsupported" };
  const errorCode = portal.lastErrorCode === null ? {} : { errorCode: portal.lastErrorCode };
  if (portal.state === "needs_reauth") return { status: "failed", ...errorCode };
  // Credentials saved but never signed in, or signed in but never read yet.
  if (portal.state === "none" || portal.lastOkAt === null) return { status: "never", ...errorCode };
  const ageSeconds = now - portal.lastOkAt;
  return ageSeconds > PORTAL_STALE_AFTER_SECONDS
    ? { status: "stale", ageHours: Math.floor(ageSeconds / 3600) }
    : { status: "ok" };
}

const APPOINTMENT_ARGS = toolArgs({
  ...windowArgs("`start`"),
  ...jqArg("get_appointments"),
  includePast: z
    .boolean()
    .optional()
    .describe("Include appointments that have already happened. Default false."),
});

export function registerAppointmentTools(server: McpServer, deps: ToolDeps): void {
  readTool(
    server,
    deps,
    {
      name: "get_appointments",
      description:
        "Upcoming appointments across every connected health system, including " +
        "every visit the patient portal lists however far ahead: when, with whom, " +
        "which department, where, and whether it is a video visit. Soonest first. " +
        "Portal visits also carry `confirmed`, `getReady` (pre-visit tasks), " +
        "`payment` (copay/prepay in USD, paid or not), `waitlist`, `directions` and " +
        "`visitInstructions`: absent when unknown, null when not applicable. " +
        "Each item says whether it came from the health record (`source: fhir`) or " +
        "the patient portal (`source: portal`). Pass `includePast: true` or a " +
        "`from` date to see past visits as well (then newest first). `coverage` " +
        "covers both sources -- the FHIR Encounter sync and the patient-portal " +
        "connection -- so check it before concluding there are no visits.",
      schema: APPOINTMENT_ARGS,
    },
    async (args, run) => {
      const all = await deps.healthSystems();
      const healthSystems = selectHealthSystems(all, run.rules, args.healthSystems);
      const upcomingOnly = args.from === undefined && args.includePast !== true;
      // `from` wins when the caller gave one: an explicit window is an explicit
      // request for history, whatever `includePast` says.
      const from =
        args.from ??
        (args.includePast === true ? undefined : new Date(run.now * 1000).toISOString());

      const collected = await collectAppointments(deps, healthSystems, {
        denied: deniedHealthSystems(all, run.rules),
        from,
        to: args.to,
        raw: args.raw,
        order: upcomingOnly ? "asc" : "desc",
      });
      const syncStatus = await deps.syncStatus();
      // Both a portal visit and a FHIR one are tagged `resourceType: "Encounter"`
      // (see `worker/src/mcp/appointment-items.ts`), so an `Encounter` deny rule hides
      // every appointment item; the synthetic `PortalVisit` coverage row must
      // disappear with them, or it would say something about the hidden data.
      const encounterDenied = run.rules.resources.has("Encounter");
      const coverage = mergeCoverage(
        buildCoverage({
          healthSystems,
          resourceTypes: ["Encounter"],
          syncStatus,
          rules: run.rules,
          now: run.now,
        }),
        encounterDenied ? [] : portalCoverage(healthSystems, run.now),
      );

      return respond({
        tool: "get_appointments",
        rules: run.rules,
        items: collected.items,
        ...(args.raw === true && { rawItems: collected.rawItems }),
        sources: collected.sources,
        limit: effectiveLimit(args.limit),
        jq: args.jq,
        healthSystemIds: collected.healthSystemIds,
        warnings: [
          ...collected.warnings,
          ...(upcomingOnly ? ["window_defaults_to_upcoming_only"] : []),
        ],
        coverage,
        now: run.now,
      });
    },
  );
}
