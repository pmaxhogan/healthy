/**
 * The scheduled safety net for the ingest runner.
 *
 * The ingest route wakes a device's runner whenever it queues a batch, and the
 * runner re-arms its own alarm while work remains, so in the ordinary course
 * nothing else is needed. This covers what is left: a wake that failed, an
 * alarm the platform gave up retrying, and the one piece of work no upload
 * announces -- a change of the `timezone` setting, after which every day
 * rollup has to be rebuilt.
 *
 * Every device is woken, not only those with rows waiting: whether a device's
 * day rollups are built for the zone now configured is something its runner
 * can tell from what it remembers, and a query here cannot tell cheaply. An
 * idle wake costs the runner three small reads. Devices are a handful.
 */

import { all } from "../../db/client.ts";
import { errorFields } from "../../lib/log.ts";
import { kickIngestRunner } from "../kick.ts";

import type { Ctx } from "../../db/client.ts";

/** Wake the ingest runner of every device. Never throws. */
export async function pokeIngestRunners(ctx: Ctx): Promise<void> {
  try {
    const devices = await all<{ id: string }>(ctx.db.prepare("SELECT id FROM devices ORDER BY id"));
    for (const { id } of devices) await kickIngestRunner(ctx.env, id);
  } catch (error) {
    ctx.log.warn("hc.poke_failed", errorFields(error));
  }
}
