/**
 * The ModMed patient-portal adapter: discovery plus a client, behind the same
 * `PortalAdapter` boundary the MyChart scrape uses (`../mychart/index.ts`), so
 * the sync, the sign-in runner and the admin API drive it without knowing which
 * vendor answered.
 *
 * Pure like the other adapters: a `fetchImpl`, a `Logger` and a clock in; the
 * jar handed in by the caller and handed back for the caller to seal.
 */

import { AppError } from "../../lib/errors.ts";

import { createModMedClient } from "./client.ts";
import { discoverModMed } from "./discovery.ts";

import type { ModMedEndpoint } from "./discovery.ts";
import type { AnyPortalEndpoint, PortalAdapter } from "../mychart/index.ts";

export type { ModMedEndpoint } from "./discovery.ts";

/** Whether a stored endpoint is a ModMed one. */
export function isModMedEndpoint(endpoint: AnyPortalEndpoint): endpoint is ModMedEndpoint {
  return (endpoint as { portal?: unknown }).portal === "modmed";
}

export function createModMedAdapter(): PortalAdapter {
  return {
    portal: "modmed",
    async discover(input, deps) {
      return discoverModMed(input.baseUrl, { fetchImpl: deps.fetchImpl, logger: deps.logger });
    },
    client(endpoint, jar, deps) {
      if (!isModMedEndpoint(endpoint)) {
        throw new AppError("portal_discovery_failed", "not a ModMed portal endpoint");
      }
      return createModMedClient({
        endpoint,
        jar,
        fetchImpl: deps.fetchImpl,
        logger: deps.logger,
        now: deps.now,
      });
    },
  };
}
