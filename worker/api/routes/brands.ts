/**
 * `GET /api/brands?q=` -- the type-ahead behind "add a health system".
 *
 * Served out of the committed `data/epic-brands.json` (see `worker/brands.ts`), so
 * it is a pure function of the query with no upstream call and no cache to warm.
 *
 * An empty `q` returns an empty list rather than the whole index: 770 records is
 * not a useful answer to "", and paging a type-ahead is not worth the round trips.
 */

import { Hono } from "hono";

import { searchBrands } from "../../brands.ts";
import { NO_STORE, readQuery } from "../http.ts";
import { brandQuerySchema } from "../schemas.ts";

import type { AppHonoEnv } from "../../auth/gate.ts";

export const brandsRouter = new Hono<AppHonoEnv>();

brandsRouter.get("/", (c) => {
  const { q } = readQuery(c, brandQuerySchema);
  return c.json(searchBrands(q ?? ""), 200, NO_STORE);
});
