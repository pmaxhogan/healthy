/**
 * Waking the ingest runner.
 *
 * The seam between the ingest route, which only queues, and the Durable Object
 * that applies what is queued. Kept as its own tiny module so the route does
 * not import the runner class (and everything the apply pipeline pulls in).
 *
 * A failure to wake the runner is never the phone's problem: the batch is
 * already durable, and the scheduled tick wakes the runner again anyway. So
 * this never throws.
 */

import { errorFields, logLine } from "../lib/log.ts";

import type { Env } from "../env.ts";

export async function kickIngestRunner(env: Env, deviceId: string): Promise<void> {
  try {
    await env.HC_INGEST.getByName(deviceId).wake(deviceId);
  } catch (error) {
    logLine("warn", "ingest.kick_failed", { deviceId, ...errorFields(error) });
  }
}
