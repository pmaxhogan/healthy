/**
 * The one `calendar_events` write the repo does not offer.
 *
 * `calendarEventsRepo` has `upsert` (which forces `state = 'active'` and clears
 * `ghosted_at`), `markGhost` (which sets the state but leaves the fingerprint
 * alone) and `restore`. Ghosting needs both halves at once: the state has to move
 * to `ghost` *and* the fingerprint has to become the ghost variant's, or the next
 * run sees a stale fingerprint, patches the event again, and every hourly sync
 * re-writes every ghost forever.
 *
 * Doing it as `upsert` then `markGhost` does not work either: the upsert clears
 * `ghosted_at`, so `markGhost` would stamp it with *this* run's clock and the
 * description's "as of" time -- and therefore the ghost fingerprint -- would move
 * on every run.
 *
 * Hence one statement, here, against `ctx.db` directly. `COALESCE(ghosted_at, ?)`
 * is what keeps the original disappearance time, and `COALESCE(?, fingerprint)`
 * lets a row-only ghost (one with no model to render) keep the fingerprint it has.
 * This belongs in `worker/db/repos/calendar-events.ts`; it lives here because that
 * file is owned elsewhere. See the hand-off notes.
 */

import { run } from "../db/client.ts";

import type { Ctx } from "../db/client.ts";

export interface GhostWrite {
  eventKey: string;
  /** The ghost variant's fingerprint, or null to keep the stored one. */
  fingerprint: string | null;
  /** Unix second to stamp if the row is not already a ghost. */
  ghostedAt: number;
}

/**
 * Mark a row ghosted, keeping the first disappearance time.
 *
 * Idempotent, and safe to call on a row that is already a ghost: only the
 * fingerprint and `last_seen_at` move in that case.
 */
export async function writeGhost(ctx: Ctx, input: GhostWrite): Promise<boolean> {
  const at = ctx.now();
  const { changes } = await run(
    ctx.db
      .prepare(
        `UPDATE calendar_events
            SET state = 'ghost',
                ghosted_at = COALESCE(ghosted_at, ?),
                fingerprint = COALESCE(?, fingerprint),
                last_seen_at = ?,
                updated_at = ?
          WHERE event_key = ?`,
      )
      .bind(input.ghostedAt, input.fingerprint, at, at, input.eventKey),
  );
  if (changes > 0) ctx.log.info("sync.event.ghosted", { eventKey: input.eventKey });
  return changes > 0;
}
