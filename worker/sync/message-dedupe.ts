/**
 * One secure message seen by more than one health system's portal: which copies
 * are the same message, and which one speaks for it.
 *
 * The visits' problem again (`portal-dedupe.ts`), with the same answer. A chart
 * linked to several organisations lets each portal's Message Center show the
 * others' conversations too: a capture had one portal listing every one of the
 * other's conversations, message for message, and the other listing the first's.
 * Filtering those copies out would lose a message whenever its own organisation is
 * not connected or its portal is failing -- the copy may be the only one there is
 * -- so every copy is kept until a better one is known, and only then collapsed.
 *
 * ### Same message
 *
 * Only on identity, never on proximity. Two copies are one message when they come
 * from different health systems and carry the same content digest: the same
 * delivery instant to the second, the same author role, and the same text
 * (`worker/db/repos/portal-messages.ts`). The capture showed exactly that -- both
 * portals render one message identically -- so nothing weaker is needed, and
 * nothing weaker is accepted: two notices sent the same second with different
 * text, or the same text a second apart, are two messages. (A time-only match is
 * the regression the visits' dedupe once had; see `sameVisitWithinHealthSystem`.)
 *
 * The portals' own conversation and organisation ids are no help here: they are
 * per-session tokens and differ between the two portals.
 *
 * ### Which copy wins
 *
 * The visits' ranking, reused as is (`portalRank`, `outranks`): the copy whose own
 * organisation the conversation belongs to (first-party) beats a copy another
 * organisation's portal shows (external), and either loses to a fresher one once
 * its portal has not been read for `STALE_SECONDS`. Ties go to the lower health
 * system id, so every caller picks the same winner.
 */

import { outranks, portalRank } from "./portal-dedupe.ts";

import type { Sighting, SightingRank } from "./portal-dedupe.ts";

/** What the matcher needs to know about one copy of a message. */
export interface MessageSighting {
  healthSystemId: string;
  /** The message's content digest: instant, author role and text. */
  fingerprint: string;
  rank: SightingRank;
}

/**
 * The rank of one stored copy. `lastReadAt` is when its portal's Message Center
 * was last read successfully (null: never), `now` the caller's clock.
 */
export function messageRank(
  external: boolean,
  lastReadAt: number | null,
  now: number,
): SightingRank {
  return portalRank(external, lastReadAt ?? 0, now);
}

/** True when two copies from different health systems are one message. */
export function sameMessageAcrossHealthSystems(a: MessageSighting, b: MessageSighting): boolean {
  return a.healthSystemId !== b.healthSystemId && a.fingerprint === b.fingerprint;
}

/** True when `a` speaks for the message over `b`. The visits' rule. */
function messageOutranks(a: MessageSighting, b: MessageSighting): boolean {
  const asVisit = (sighting: MessageSighting): Sighting => ({
    healthSystemId: sighting.healthSystemId,
    start: NaN,
    rank: sighting.rank,
  });
  return outranks(asVisit(a), asVisit(b));
}

/**
 * One copy per message across health systems: the winner of each group, in
 * precedence order. A message only one health system has is always kept, and so
 * are two copies from the same health system (they are two messages there).
 */
export function collapseMessages<T extends { sighting: MessageSighting }>(
  entries: readonly T[],
): T[] {
  const byPrecedence = [...entries];
  byPrecedence.sort((a, b) => {
    if (messageOutranks(a.sighting, b.sighting)) return -1;
    return messageOutranks(b.sighting, a.sighting) ? 1 : 0;
  });
  const kept: T[] = [];
  const winners = new Map<string, MessageSighting[]>();
  for (const entry of byPrecedence) {
    const rivals = winners.get(entry.sighting.fingerprint) ?? [];
    if (rivals.some((winner) => sameMessageAcrossHealthSystems(winner, entry.sighting))) continue;
    rivals.push(entry.sighting);
    winners.set(entry.sighting.fingerprint, rivals);
    kept.push(entry);
  }
  return kept;
}
