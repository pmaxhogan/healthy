/**
 * `get_health_summary`: the one tool to call first.
 *
 * It answers "what is in here, and what has happened lately" in a single round
 * trip -- a count of every cached resource type per health system, plus the five
 * most recent appointments, conditions, medications and lab results. A model that
 * starts here knows which of the other twenty-three tools are worth calling.
 *
 * The counts are emitted as items carrying `resourceType`, not as a separate
 * `counts` block. That is what makes a `resource` deny rule complete: denying
 * Coverage has to remove the Coverage *count* as well as the Coverage records, or
 * the summary would still say how many there are.
 */

import { WINDOW_ARGS, toolArgs } from "../args.ts";
import { collect, effectiveLimit, selectProviders, spec } from "../collect.ts";
import { BINARY_TEXT_TYPE, MAX_LIMIT } from "../deps.ts";
import { LABORATORY, hasCategory } from "../match.ts";
import { respond } from "../respond.ts";

import { readTool } from "./register.ts";

import type { CollectSpec, TaggedItem } from "../collect.ts";
import type { ProviderInfo, ToolDeps } from "../deps.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** How many recent items of each section the summary carries. */
const RECENT_PER_SECTION = 5;

/**
 * The four things a summary is asked about, and how to read each one.
 *
 * The label goes out as `section`, not `category`: several normalized shapes
 * already carry a FHIR `category` array, and reusing the name would have the
 * summary's own label silently overwrite the resource's.
 */
const SECTIONS: { section: string; specs: () => CollectSpec[] }[] = [
  {
    section: "appointments",
    specs: () => [spec("Encounter", { dateOf: (item) => item.start })],
  },
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

async function recentItems(
  deps: ToolDeps,
  providers: readonly ProviderInfo[],
): Promise<TaggedItem[]> {
  const out: TaggedItem[] = [];
  for (const entry of SECTIONS) {
    const collected = await collect(deps, providers, { specs: entry.specs() });
    for (const item of collected.items.slice(0, RECENT_PER_SECTION)) {
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
        "has cached (items with kind `count`), plus the five most recent " +
        "appointments, conditions, medications and lab results across all of them " +
        "(kind `recent`, labelled by `section`).",
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
      items.push(...(await recentItems(deps, providers)));

      return respond({
        tool: "get_health_summary",
        rules: run.rules,
        items,
        limit: effectiveLimit(args.limit ?? MAX_LIMIT),
        providerIds: providers.map((provider) => provider.id),
        now: run.now,
      });
    },
  );
}
