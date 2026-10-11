/**
 * `/api/google` -- the one calendar account, its pickers, and disconnecting it.
 *
 * The account label is the thing to be careful with. There is exactly one string
 * in this app that names the owner -- the primary calendar's id, which is their
 * email address -- and it lives in `google_account.email_enc`. It is read here so
 * the UI can show *which* account is connected, and it is masked
 * (`p…n@gmail.com`) before it is serialised. The plaintext never reaches a
 * response body and, per CLAUDE.md, never reaches a log line at all.
 *
 * The two pickers (`/calendars`, `/colors`) go through the sync engine's calendar
 * client rather than building their own: that client owns the refresh lease, and a
 * second code path with its own token handling is how two concurrent refreshes end
 * up racing.
 */

import { Hono } from "hono";

import { getCalendarId } from "../../db/settings.ts";
import { AppError } from "../../lib/errors.ts";
import { googleOAuthFor } from "../../oauth/google-client.ts";
import { closeAlert } from "../close-alert.ts";
import { toGoogleAccountDto } from "../dto.ts";
import { NO_STORE, apiContext } from "../http.ts";

import type { AppHonoEnv } from "../../auth/gate.ts";
import type { GoogleAccountRow } from "../../db/rows.ts";
import type { ApiContext } from "../http.ts";
import type { CalendarOptionDto, ColorOptionDto, GoogleAccountDto } from "@shared/types.ts";

/** `alerts.subject` for the calendar account. Mirrors `db/repos/alerts.ts`. */
const GOOGLE_SUBJECT = "google";

export const googleRouter = new Hono<AppHonoEnv>();

/**
 * `not_connected` means "the owner has never consented", which the UI shows
 * differently from an account they disconnected on purpose -- one offers a connect
 * button, the other explains that syncing is off.
 *
 * `last_refresh_at` is the discriminator rather than the token columns:
 * `disconnect()` destroys the tokens and clears `connected_at`, so afterwards the row
 * looks exactly like a freshly migrated one except for that column, which every token
 * write stamps and nothing clears.
 */
function statusOf(row: GoogleAccountRow): GoogleAccountDto["status"] {
  const neverConnected = row.status === "disconnected" && row.last_refresh_at === null;
  return neverConnected ? "not_connected" : row.status;
}

/** The calendar account as the UI sees it. Shared with /api/overview. */
export async function projectGoogle(api: ApiContext): Promise<GoogleAccountDto> {
  const [row, calendarId] = await Promise.all([api.repos.google.get(), getCalendarId(api.ctx)]);
  // The repo is the only thing that opens the sealed column; `label` is the
  // plaintext address, and `toGoogleAccountDto` masks it on the way out.
  const secrets = await api.repos.google.getSecrets();
  return toGoogleAccountDto({
    status: statusOf(row),
    label: secrets.email,
    accessExpiresAt: row.access_expires_at,
    lastRefreshAt: row.last_refresh_at,
    needsReauthSince: row.needs_reauth_since,
    connectedAt: row.connected_at,
    calendarId,
  });
}

googleRouter.get("/", async (c) => {
  const api = apiContext(c);
  return c.json(await projectGoogle(api), 200, NO_STORE);
});

/**
 * Disconnect the calendar account.
 *
 * Revocation at Google is attempted first and is best effort: if it fails the
 * local tokens are still destroyed, because leaving them behind after the owner
 * pressed "disconnect" is the worse outcome. The refresh token is revoked rather
 * than the access token -- revoking a refresh token invalidates the whole grant,
 * which is what "disconnect" means.
 */
googleRouter.delete("/", async (c) => {
  const api = apiContext(c);
  const secrets = await api.repos.google.getSecrets();
  if (secrets.refreshToken !== null) {
    const { client } = googleOAuthFor(c.env, c.req.url, api.ports.fetch);
    // `revoke` never throws; it reports and returns false.
    await client.revoke(secrets.refreshToken);
  }
  await api.repos.google.disconnect();
  await closeAlert(api, c.env, GOOGLE_SUBJECT);
  return c.json({ ok: true }, 200, NO_STORE);
});

/** The calendars the owner could sync into. Owned calendars only; see the client. */
googleRouter.get("/calendars", async (c) => {
  const api = apiContext(c);
  await requireConnected(api);
  const calendar = await api.ports.sync.getGoogleCalendarFor(api.ctx);
  const calendars = await calendar.listCalendars();
  const options: CalendarOptionDto[] = calendars.map((entry) => ({
    id: entry.id,
    summary: entry.summary,
    primary: entry.primary,
    timeZone: entry.timeZone === "" ? null : entry.timeZone,
    backgroundColor: entry.backgroundColor,
  }));
  return c.json(options, 200, NO_STORE);
});

/** The live event palette, so the colour picker shows Google's actual swatches. */
googleRouter.get("/colors", async (c) => {
  const api = apiContext(c);
  await requireConnected(api);
  const calendar = await api.ports.sync.getGoogleCalendarFor(api.ctx);
  const colors = await calendar.getColors();
  const options: ColorOptionDto[] = colors.map((entry) => ({
    id: entry.id,
    background: entry.background,
    foreground: entry.foreground,
  }));
  return c.json(options, 200, NO_STORE);
});

/**
 * 409 rather than a 502 from deep inside the calendar client.
 *
 * "You have not connected Google yet" is a state the UI renders, not an upstream
 * failure, and the difference matters: one is a button to press, the other is a
 * reason to retry later.
 */
async function requireConnected(api: ApiContext): Promise<void> {
  const row = await api.repos.google.get();
  if (row.refresh_token_enc === null) {
    throw new AppError("not_connected", "Google Calendar is not connected");
  }
}
