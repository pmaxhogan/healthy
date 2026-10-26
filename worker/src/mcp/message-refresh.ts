/**
The token bucket `refresh_messages` is held to, and the arithmetic over it.

`sync_health_systems` is held to cooldowns of a quarter hour and more, which
is right for a sync and wrong for a conversation: "I just sent my doctor a
message -- did they answer?" is asked a few times in a few minutes and then
not for hours. So the message refresh gets a bucket instead. It holds
`capacity` refreshes per health system, all of which may be spent at once,
and earns one back every `refillSeconds`. Sustained, that is one Message
Center read every two minutes at most, which is a person checking their inbox
and not a scraper; in a burst, it is enough for a back and forth.

Pure: the stored row comes in, numbers come out. The atomic spend is
`worker/src/db/repos/mcp-message-refreshes.ts`.
*/

import type { McpMessageRefreshEntry, McpMessageRefreshLimits } from "../db/rows.ts";

/** Five at once; one back every two minutes. See the module comment. */
export const MESSAGE_REFRESH_LIMITS: Readonly<McpMessageRefreshLimits> = {
  capacity: 5,
  refillSeconds: 120,
};

/** The bucket's level at `now`: full when it was never used. Fractional. */
export function bucketLevel(
  entry: McpMessageRefreshEntry | null,
  now: number,
  limits: McpMessageRefreshLimits = MESSAGE_REFRESH_LIMITS,
): number {
  if (entry === null) return limits.capacity;
  const earned = Math.max(0, now - entry.updatedAt) / limits.refillSeconds;
  return Math.min(limits.capacity, entry.tokens + earned);
}

/** Unix seconds the bucket next holds a whole token: `now` when it already does. */
export function nextTokenAt(
  level: number,
  now: number,
  limits: McpMessageRefreshLimits = MESSAGE_REFRESH_LIMITS,
): number {
  return level >= 1 ? now : now + Math.ceil((1 - level) * limits.refillSeconds);
}
