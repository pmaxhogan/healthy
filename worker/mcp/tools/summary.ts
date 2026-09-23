/**
 * `get_health_summary`: the one tool to call first.
 *
 * It answers "what is in here, and what has happened lately" in a single round
 * trip -- a count of every cached resource type per health system, plus the five
 * appointments nearest to now (the patient portal's upcoming visits included) and
 * the five most recent conditions, medications and lab results. A model that
 * starts here knows which of the other twenty-three tools are worth calling.
 *
 * The counts are emitted as items carrying `resourceType`, not as a separate
 * `counts` block. That is what makes a `resource` deny rule complete: denying
 * Coverage has to remove the Coverage *count* as well as the Coverage records, or
 * the summary would still say how many there are.
 */

import { collectAppointments } from "../appointment-items.ts";
import { WINDOW_ARGS, toolArgs } from "../args.ts";
import { collect, effectiveLimit, selectProviders, spec } from "../collect.ts";
import { BINARY_TEXT_TYPE } from "../deps.ts";
import { LABORATORY, hasCategory } from "../match.ts";
import { respond } from "../respond.ts";

import { readTool } from "./register.ts";

import type { CollectSpec, TaggedItem } from "../collect.ts";
import type { ProviderInfo, ToolDeps } from "../deps.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** How many recent items of each section the summary carries. */
const RECENT_PER_SECTION = 5;

/**
 * Three of the four things a summary is asked about, and how to read each one.
 * The fourth, appointments, is {@link nearestAppointments}.
 *
 * The label goes out as `section`, not `category`: several normalized shapes
 * already carry a FHIR `category` array, and reusing the name would have the
 * summary's own label silently overwrite the resource's.
 */
const SECTIONS: { section: string; specs: () => CollectSpec[] }[] = [
  {
    section: "conditions",
    specs: () => [spec("Condition", { dateOf: (item) => item.recorded ?? item.onset })],
  },
  {
    section: "medications",
    specs: () => [spec("MedicationRequest", { dateOf: (item) => item.authoredOn })],
  },
  {
    section: "labs",
    specs: () => [
      spec("Observation", {
        dateOf: (item) => item.effective ?? item.issued,
        keep: (item, resource) => hasCategory(resource, item.category, LABORATORY),
      }),
    ],
  },
];

/**
 * The appointments nearest to now: the next ones first, then the latest past
 * ones to fill the section.
 *
 * Read through `collectAppointments`, the same merge `get_appointments` uses, so
 * the patient portal's upcoming visits are here too -- they are the only
 * upcoming appointments there are, because Epic's FHIR view never returns one
 * before it happens. "Most recent" by start date alone would fill the section
 * with the furthest-out visits and hide next week's.
 */
async function nearestAppointments(
  deps: ToolDeps,
  providers: readonly ProviderInfo[],
  now: number,
  perSection: number,
): Promise<TaggedItem[]> {
  const { items } = await collectAppointments(deps, providers, { order: "asc" });
  const nowMs = now * 1000;
  const isUpcoming = (item: TaggedItem): boolean =>
    typeof item.start === "string" && Date.parse(item.start) >= nowMs;
  const upcoming: TaggedItem[] = [];
  // Latest first; `items` is soonest first, so each past one goes to the front.
  const past: TaggedItem[] = [];
  for (const item of items) {
    if (isUpcoming(item)) upcoming.push(item);
    else past.unshift(item);
  }
  return [...upcoming, ...past].slice(0, perSection);
}

/**
 * How many items each section carries.
 *
 * {@link RECENT_PER_SECTION} by default -- this tool is a fast overview, not a
 * full read, and every section has its own tool (`get_appointments`,
 * `get_conditions`, ...) for the complete list. But it is not a hidden ceiling:
 * a caller that passes its own `limit` gets that many per section instead, so
 * asking for more here is always honoured rather than silently capped at five.
 */
function perSectionLimit(limit: number | undefined): number {
  return limit ?? RECENT_PER_SECTION;
}

async function recentItems(
  deps: ToolDeps,
  providers: readonly ProviderInfo[],
  now: number,
  perSection: number,
): Promise<TaggedItem[]> {
  const out: TaggedItem[] = [];
  const appointments = await nearestAppointments(deps, providers, now, perSection);
  out.push(...appointments.map((item) => ({ ...item, kind: "recent", section: "appointments" })));
  for (const entry of SECTIONS) {
    const collected = await collect(deps, providers, { specs: entry.specs() });
    for (const item of collected.items.slice(0, perSection)) {
      out.push({ ...item, kind: "recent", section: entry.section });
    }
  }
  return out;
}

export function registerSummaryTool(server: McpServer, deps: ToolDeps): void {
  readTool(
    server,
    deps,
    {
      name: "get_health_summary",
      description:
        "Start here. How many of each resource type each connected health system " +
        "has cached (items with kind `count`), plus the five appointments nearest " +
        "to now (upcoming first, patient-portal visits included) and the five most " +
        "recent conditions, medications and lab results across all of them " +
        "(kind `recent`, labelled by `section`). Five is a default for a fast " +
        "overview, not a ceiling: pass `limit` to get that many per section " +
        "instead, or call the section's own tool (`get_appointments`, " +
        "`get_conditions`, ...) for the complete list.",
      schema: toolArgs(WINDOW_ARGS),
    },
    async (args, run) => {
      const providers = selectProviders(await deps.providers(), run.rules, args.providers);
      const names = new Map(providers.map((provider) => [provider.id, provider.displayName]));

      const items: TaggedItem[] = [];
      const counts = await deps.counts();
      for (const count of counts) {
        const name = names.get(count.providerId);
        // `_binary_text` is this server's own cache of decoded documents, not a
        // FHIR resource type, so it has no business in a record summary.
        if (name === undefined || count.resourceType === BINARY_TEXT_TYPE) continue;
        items.push({
          kind: "count",
          provider: name,
          providerId: count.providerId,
          resourceType: count.resourceType,
          count: count.count,
        });
      }
      items.push(...(await recentItems(deps, providers, run.now, perSectionLimit(args.limit))));

      return respond({
        tool: "get_health_summary",
        rules: run.rules,
        items,
        limit: effectiveLimit(args.limit),
        providerIds: providers.map((provider) => provider.id),
        now: run.now,
      });
    },
  );
}
