/**
 * `/api/runs` -- the run log.
 *
 * Counts and stable error codes only, which is a property of the table rather than
 * of this route: `run_log.summary_json` has nowhere to put an appointment, a name or
 * an organisation. A run with `finishedAt: null` is one that was cut off mid-flight
 * (a Worker that hit its CPU limit, a deploy during a sync) and is shown as such
 * rather than hidden.
 *
 * ### Why `refresh` is hidden unless asked for
 *
 * The token keepalive runs every hour and writes a `refresh` row each time, so a
 * plain "last 25 runs" is 25 keepalives and none of the syncs the owner came to
 * look at. `?kind=refresh` asks for them specifically, and `?kind=` any other value
 * narrows to that kind alone.
 */

import { Hono } from "hono";

import { toRunDto } from "../dto.ts";
import { NO_STORE, apiContext, readQuery, runQuerySchema } from "../http.ts";

import type { AppHonoEnv } from "../../auth/gate.ts";
import type { RunKind } from "@shared/types.ts";

/** Runs per page when the caller does not say. */
const DEFAULT_RUN_LIMIT = 25;

/** The kinds an unfiltered listing shows. See the module comment. */
const INTERESTING: ReadonlySet<RunKind> = new Set<RunKind>(["calendar", "full", "manual"]);

/**
 * How many rows to read when filtering in memory.
 *
 * The repo can filter by one kind, not by a set, so an unfiltered request reads a
 * wider window and narrows it here. Four times the page is enough for the hourly
 * keepalive not to crowd out a daily full refresh.
 */
const FILTER_FACTOR = 4;

export const runsRouter = new Hono<AppHonoEnv>();

runsRouter.get("/", async (c) => {
  const api = apiContext(c);
  const { limit, kind } = readQuery(c, runQuerySchema);
  const page = limit ?? DEFAULT_RUN_LIMIT;

  let entries;
  if (kind === undefined) {
    // A wider window, narrowed here: the repo filters by one kind, not by a set.
    const window = await api.repos.runLog.listRecent({ limit: page * FILTER_FACTOR });
    entries = window.filter((entry) => INTERESTING.has(entry.kind)).slice(0, page);
  } else {
    entries = await api.repos.runLog.listRecent({ kind, limit: page });
  }

  return c.json(
    entries.map((entry) => toRunDto(entry)),
    200,
    NO_STORE,
  );
});
