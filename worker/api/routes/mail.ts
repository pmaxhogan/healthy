/**
 * `/api/mail` -- the admin view of `mail_inbox`: recent entries, the sender
 * allowlist, and a way to prove the path works without waiting for a real
 * email.
 *
 * Everything here reads or writes through the repo and `dto.ts`; no route
 * handler ever touches `code_enc` or opens a sealed column directly.
 */

import { Hono } from "hono";

import { getSetting, setSetting } from "../../db/settings.ts";
import { formatAllowlistCsv, mailTtlSeconds } from "../../mail/classify.ts";
import { toMailInboxEntryDto, toMailSettingsDto } from "../dto.ts";
import { NO_STORE, apiContext, limitQuerySchema, readJson, readQuery } from "../http.ts";
import { mailAllowlistSchema } from "../schemas.ts";

import type { AppHonoEnv } from "../../auth/gate.ts";
import type { MailInboxEntryDto, MailSettingsDto } from "@shared/types.ts";

/** Entries per page when the caller does not say. */
const DEFAULT_MAIL_LIMIT = 50;

export const mailRouter = new Hono<AppHonoEnv>();

mailRouter.get("/inbox", async (c) => {
  const api = apiContext(c);
  const { limit } = readQuery(c, limitQuerySchema);
  const entries = await api.repos.mailInbox.listRecent(limit ?? DEFAULT_MAIL_LIMIT);
  return c.json<MailInboxEntryDto[]>(
    entries.map((entry) => toMailInboxEntryDto(entry)),
    200,
    NO_STORE,
  );
});

mailRouter.get("/settings", async (c) => {
  const api = apiContext(c);
  const csv = await getSetting(api.ctx, "mail_sender_allowlist");
  return c.json<MailSettingsDto>(toMailSettingsDto(csv), 200, NO_STORE);
});

mailRouter.put("/settings", async (c) => {
  const api = apiContext(c);
  const body = await readJson(c, mailAllowlistSchema);
  await setSetting(api.ctx, "mail_sender_allowlist", formatAllowlistCsv(body.allowlist));
  const csv = await getSetting(api.ctx, "mail_sender_allowlist");
  return c.json<MailSettingsDto>(toMailSettingsDto(csv), 200, NO_STORE);
});

/**
 * Insert a synthetic 'other' row to prove the inbox path end to end.
 *
 * No email is sent and nothing is parsed: this exercises the same repo and
 * DTO the real `email()` handler uses, without needing a real message to
 * arrive. The sender is a reserved documentation domain (RFC 2606), never a
 * real address.
 */
mailRouter.post("/test", async (c) => {
  const api = apiContext(c);
  const entry = await api.repos.mailInbox.insert({
    fromAddr: "mail-test@example.com",
    subject: "Healthy mail test",
    kind: "other",
    code: null,
    url: null,
    receivedAt: api.ctx.now(),
    // The same TTL a real 'other' row gets: a test row is a row, and one kept
    // for ever is one more thing holding a sender nobody chose.
    expiresAt: api.ctx.now() + mailTtlSeconds("other"),
    rawSize: 0,
  });
  return c.json<MailInboxEntryDto>(toMailInboxEntryDto(entry), 201, NO_STORE);
});
