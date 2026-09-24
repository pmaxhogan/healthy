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
 * `source: "fhir" | "portal"` -- see `worker/mcp/appointment-items.ts`, which
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
import { WINDOW_ARGS, toolArgs } from "../args.ts";
import { deniedHealthSystems, effectiveLimit, selectHealthSystems } from "../collect.ts";
import { respond } from "../respond.ts";

import { readTool } from "./register.ts";

import type { ToolDeps } from "../deps.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const APPOINTMENT_ARGS = toolArgs({
  ...WINDOW_ARGS,
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
        "Each item says whether it came from the health record (`source: fhir`) or " +
        "the patient portal (`source: portal`). Pass `includePast: true` or a " +
        "`from` date to see past visits as well (then newest first). To keep only " +
        'what you need, pass `jq`, e.g. `[.[] | select(.start < "2026-12-01") | {start, source}]`.',
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

      return respond({
        tool: "get_appointments",
        rules: run.rules,
        items: collected.items,
        ...(args.raw === true && { rawItems: collected.rawItems }),
        limit: effectiveLimit(args.limit),
        jq: args.jq,
        healthSystemIds: collected.healthSystemIds,
        warnings: [
          ...collected.warnings,
          ...(upcomingOnly ? ["window_defaults_to_upcoming_only"] : []),
        ],
        now: run.now,
      });
    },
  );
}
