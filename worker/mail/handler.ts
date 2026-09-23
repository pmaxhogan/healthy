/**
 * The Worker's `email()` export, wired up in `worker/index.ts`.
 *
 * Pipeline: size guard -> parse -> sender allowlist -> classify -> store.
 * Every rejection path calls `setReject` and returns normally rather than
 * throwing: a thrown error from an `email()` handler tempfails the message,
 * which makes the sending MTA retry the exact same mail forever, whereas
 * `setReject` tells it plainly, once, that the message will never be
 * accepted. A storage failure after a message has already passed the
 * allowlist is the one path that *is* allowed to throw -- that failure is
 * this Worker's own, not the sender's, and a tempfail-and-retry is the right
 * outcome for it.
 *
 * The allowlist check is against the parsed `From:` header, never
 * `message.from` (the SMTP envelope sender): see `worker/mail/parse.ts` for
 * why those two disagree for a Gmail-forwarded message.
 */

import { reposFor } from "../db/index.ts";
import { getSetting } from "../db/settings.ts";
import { errorFields, makeLogger } from "../lib/log.ts";

import {
  classify,
  domainOf,
  isAllowedSender,
  mailTtlSeconds,
  parseAllowlistCsv,
} from "./classify.ts";
import { parseInboundEmail } from "./parse.ts";

import type { Env } from "../env.ts";
import type { ParsedMail } from "./parse.ts";

/**
 * No legitimate OTP or Gmail-verification email is anywhere near this size;
 * a message over it is refused before postal-mime ever reads it.
 */
const MAX_RAW_SIZE_BYTES = 1_048_576;
const MAX_SUBJECT_CHARS = 500;

export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const log = makeLogger({ src: "mail" });

  if (message.rawSize > MAX_RAW_SIZE_BYTES) {
    message.setReject("message too large");
    log.warn("mail.rejected", { reason: "too_large", rawSize: message.rawSize });
    return;
  }

  const repos = reposFor(env.DB, env, { log });
  const now = repos.ctx.now();

  let parsed: ParsedMail | null;
  try {
    parsed = await parseInboundEmail(message.raw, message.rawSize, now);
  } catch {
    parsed = null;
  }
  if (parsed === null) {
    message.setReject("could not parse message");
    log.warn("mail.rejected", { reason: "parse_failed", rawSize: message.rawSize });
    return;
  }

  const fromDomain = domainOf(parsed.from);
  const allowlistCsv = await getSetting(repos.ctx, "mail_sender_allowlist");
  if (!isAllowedSender(parsed.from, parseAllowlistCsv(allowlistCsv))) {
    message.setReject("not allowed");
    log.warn("mail.rejected", { reason: "not_allowed", fromDomain, rawSize: parsed.rawSize });
    return;
  }

  const classification = classify(parsed);
  const subject = parsed.subject.slice(0, MAX_SUBJECT_CHARS);

  try {
    const entry = await repos.mailInbox.insert({
      fromAddr: parsed.from,
      subject: subject.length > 0 ? subject : null,
      kind: classification.kind,
      code: classification.code,
      url: classification.url,
      receivedAt: now,
      // Every kind gets one, not just 'otp': see `mailTtlSeconds`.
      expiresAt: now + mailTtlSeconds(classification.kind),
      rawSize: parsed.rawSize,
    });
    log.info("mail.accepted", {
      id: entry.id,
      kind: entry.kind,
      fromDomain,
      rawSize: entry.rawSize,
      // Which keyword tipped classification into 'otp' -- never the code
      // itself -- so a future misclassification (like the one this field
      // was added for) can be diagnosed from the logs alone.
      ...(classification.reason !== null && { otp_match: classification.reason }),
    });
  } catch (error) {
    log.error("mail.insert_failed", { fromDomain, ...errorFields(error) });
    throw error;
  }

  ctx.waitUntil(
    (async (): Promise<void> => {
      try {
        await repos.mailInbox.purgeExpired(now);
      } catch (error) {
        log.warn("mail.purge_failed", errorFields(error));
      }
    })(),
  );
}
