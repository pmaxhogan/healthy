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
 */

import { z } from "zod";

import { appointmentViewFromEncounter, mapResolver } from "../../fhir/normalize/index.ts";
import { WINDOW_ARGS, toolArgs } from "../args.ts";
import { collect, effectiveLimit, selectProviders, spec } from "../collect.ts";
import { respond } from "../respond.ts";

import { readTool } from "./register.ts";

import type { ToolDeps } from "../deps.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * `appointmentViewFromEncounter` takes a NormalizeCtx but reads only
 * `ctx.provider` -- every reference it needs was already resolved into the
 * normalized Encounter. An empty resolver is therefore correct, not a shortcut.
 */
const NO_REFS = mapResolver([]);

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
        "Upcoming appointments across every connected health system: when, with " +
        "whom, which department, where, and whether it is a video visit. Pass " +
        "`includePast: true` or a `from` date to see past visits as well.",
      schema: APPOINTMENT_ARGS,
    },
    async (args, run) => {
      const providers = selectProviders(await deps.providers(), run.rules, args.providers);
      // `from` wins when the caller gave one: an explicit window is an explicit
      // request for history, whatever `includePast` says.
      const from =
        args.from ??
        (args.includePast === true ? undefined : new Date(run.now * 1000).toISOString());

      const collected = await collect(deps, providers, {
        specs: [
          spec("Encounter", {
            dateOf: (item) => item.start,
            project: (item) => ({
              resourceType: "Encounter",
              ...appointmentViewFromEncounter(item, { provider: item.provider, refs: NO_REFS }),
            }),
          }),
        ],
        from,
        to: args.to,
        raw: args.raw,
      });

      return respond({
        tool: "get_appointments",
        rules: run.rules,
        items: collected.items,
        ...(args.raw === true && { rawItems: collected.rawItems }),
        limit: effectiveLimit(args.limit),
        providerIds: collected.providerIds,
        warnings:
          args.from === undefined && args.includePast !== true
            ? ["window_defaults_to_upcoming_only"]
            : [],
        now: run.now,
      });
    },
  );
}
