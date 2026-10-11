/**
 * `/api/settings` -- the `settings` table, as one object.
 *
 * `PUT` is a patch, not a replace: the body carries only the keys that changed and
 * `setSettings` validates all of them before writing any, so one bad field rejects
 * the whole payload rather than half-applying it.
 *
 * The timezone is the field with teeth. It has no default in source (a real one
 * would disclose where the owner lives), the sync's local-day window depends on
 * it, and `Intl` accepts some strings that are not zones -- so it is validated
 * against the runtime's own zone database in `schemas.ts` before it is stored.
 */

import { Hono } from "hono";

import { getAllSettings, setSettings } from "../../db/settings.ts";
import { fromSettingsPatch, toSettingsDto } from "../dto.ts";
import { NO_STORE, apiContext, readJson } from "../http.ts";
import { settingsPatchSchema } from "../schemas.ts";

import type { AppHonoEnv } from "../../auth/gate.ts";

export const settingsRouter = new Hono<AppHonoEnv>();

settingsRouter.get("/", async (c) => {
  const api = apiContext(c);
  return c.json(toSettingsDto(await getAllSettings(api.ctx)), 200, NO_STORE);
});

settingsRouter.put("/", async (c) => {
  const api = apiContext(c);
  const patch = await readJson(c, settingsPatchSchema);
  await setSettings(api.ctx, fromSettingsPatch(patch));
  // The stored state, re-read: the response is what the UI renders, and echoing
  // the request back would hide a key that was accepted and then ignored.
  return c.json(toSettingsDto(await getAllSettings(api.ctx)), 200, NO_STORE);
});
