# Inbound mail: capturing a portal's emailed 2FA code

The portal-sync path (Plan B) signs in to a patient portal that emails a
one-time code instead of, or alongside, an authenticator app. Since the
Worker has no browser and no human present to read that email, this feature
gives it a mailbox of its own: Cloudflare Email Routing delivers the message
straight to the Worker, which decides in milliseconds whether to keep it.

Nothing here sends mail. It is a read-only inbox for exactly two kinds of
message the sign-in flow needs, plus a catch-all for anything else an
allowlisted sender sends.

## The pipeline

`worker/index.ts` exports an `email(message, env, ctx)` handler alongside
`fetch` and `scheduled`, wired to `handleInboundEmail` in
`worker/mail/handler.ts`. Every inbound message goes through, in order:

1. **Size guard.** A message over 1 MiB is refused (`setReject`) before
   anything reads it. No legitimate OTP or verification email is anywhere
   close to that size.
2. **Parse** (`worker/mail/parse.ts`, via
   [`postal-mime`](https://github.com/postalsys/postal-mime)). Only four
   fields survive: the header `From:` address, the subject, the plain-text
   body, and the message's byte size. HTML and every attachment are read by
   postal-mime and then dropped on the floor — they are never part of the
   parsed shape this repository passes around, so a later change cannot
   accidentally start keeping one.
3. **Sender allowlist** (`worker/mail/classify.ts`). The parsed message's
   `From:` header domain — never `ForwardableEmailMessage.from`, which is
   the SMTP envelope sender — is checked against the comma-separated
   `mail_sender_allowlist` setting. A domain matches if it _contains_ an
   allowlist entry, so the shipped default, `mychart.,google.com`, matches
   any Epic organisation's own MyChart hostname without naming one, plus
   Gmail's forwarding-verification sender. Anything else is
   `setReject("not allowed")` and nothing is stored.
4. **Classify** (still `classify.ts`). An allowlisted message becomes one of:
   - `otp` — the subject or body mentions a code (`code`, `passcode`,
     `verification`, `one-time`, `security code`) and a 4–8 digit run
     appears nearby. The digit run closest to the hint word wins, so a
     reference number or a phone number elsewhere in the email does not get
     mistaken for the code.
   - `forward_verify` — the sender is exactly
     `forwarding-noreply@google.com`, Gmail's own "confirm this forwarding
     address" email. A 6–12 digit confirmation code and the confirmation
     link are extracted the same way.
   - `other` — an allowlisted sender whose content matches neither pattern.
     Stored with no code, purely so the admin UI's inbox table shows that
     mail is arriving at all.
5. **Store.** One `mail_inbox` row per message (`worker/db/repos/mail-inbox.ts`).
   A code, when there is one, is sealed the same way every other secret in
   this repository is sealed — AES-GCM-256, AAD bound to
   `mail_inbox.code_enc.<id>` — before it ever reaches D1.

A storage failure after a message has passed the allowlist is allowed to
throw: Cloudflare tempfails the message and the sending server retries,
which is the right outcome for this Worker's own failure. Every rejection
path calls `setReject` and returns normally instead, because a thrown error
from a rejection would also tempfail — and retry the exact same
never-going-to-be-accepted message forever.

## Data model

`mail_inbox` (added by the migration that also adds the portal-sync tables):
`id`, `received_at`, `from_addr`, `subject`, `kind`
(`otp` | `forward_verify` | `other`), `code_enc` (sealed; null for `other`),
`consumed_at`, `expires_at` (10 minutes after receipt, for `otp` only), and
`raw_size`. No message body is ever stored, at any kind.

## Reading a code back out: the repo's two entry points

- **`takeFreshOtp({ since, now })`**, used by the portal sign-in flow (not
  part of this wave): claims the newest unconsumed, unexpired `otp` row
  received after the sign-in attempt's own `SendCode` time, and marks it
  consumed in the same `UPDATE ... RETURNING` statement. Two callers racing
  each other (a retry racing the original attempt) can never both claim the
  same code — the loser's `UPDATE` matches no row.
- **`listRecent(limit)`**, used by the admin UI: never opens an `otp` row's
  code, even though nothing stops it technically. A one-time login code has
  no legitimate reason to ever appear on a screen. It _does_ open a
  `forward_verify` row's code and link, because that one is not a secret —
  it exists specifically so a human can read and use it to finish the Gmail
  setup step below.

## Admin API (`/api/mail`)

| Route                            | What it does                                                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/mail/inbox`            | Recent entries: kind, **sender domain** (never the full address), subject, received/consumed times, size, and the `forward_verify` code/link if pending. |
| `GET /api/mail/settings` / `PUT` | Read or replace the sender allowlist.                                                                                                                    |
| `POST /api/mail/test`            | Inserts a synthetic `other` row to prove the path end to end. Sends no email.                                                                            |

## The admin UI (`/mail`)

Shows the setup checklist below, the pending Gmail verification code/link
(when one is waiting), the recent-entries table, and the allowlist editor.

## One-time setup

1. **Cloudflare Email Routing**, on the Worker's own subdomain only — never
   the account's apex domain, which may already have its own mail setup.
   Dashboard: zone → **Email → Email Routing → Settings → Subdomains**, add
   the Worker's subdomain; then **Routing rules → Create address**, action
   **Send to a Worker**, target this Worker. Cloudflare adds MX/TXT records
   scoped to that subdomain only.
2. **Gmail**, entirely through its own web UI — there is no API path for a
   personal Gmail account (Google's `forwardingAddresses`/`filters` write
   endpoints require Workspace domain-wide delegation):
   - **Settings → Forwarding and POP/IMAP → Add a forwarding address** →
     enter the mail address the step above created, e.g.
     `2fa@<your worker hostname>`.
   - Gmail emails that address a confirmation. Since nothing reads that
     mailbox but this Worker, open the **Mail** admin page (`/mail`) — the
     confirmation shows up there as a `forward_verify` row within seconds —
     and either open its link or paste its code back into Gmail's dialog.
   - **Settings → Filters and Blocked Addresses → Create a new filter**,
     matching the portal's login-code sender/subject, then check **only**
     "Forward it to" the new address. Leaving "Skip the Inbox" and "Delete
     it" unchecked keeps the original in the owner's own inbox too — the
     Worker only ever sees a copy.

## Security properties

- **Sender allowlist.** A message from anywhere else is refused before it is
  even parsed; no `mail_inbox` row is ever written for it.
- **Short TTL, single use.** An `otp` row expires 10 minutes after receipt
  and `takeFreshOtp` marks it consumed atomically the moment it is claimed —
  the same code can never be used by two sign-in attempts, and a stale one
  cannot be replayed later.
- **No bodies stored, ever.** Only the four fields listed above survive
  parsing, for every kind, including `other`.
- **Never logged.** `handleInboundEmail` logs only the kind, the sender's
  _domain_, the message size, and (on acceptance) the row's id — never the
  full address, the subject or a code. See `worker/lib/log.ts` and
  `SECURITY.md` for the redaction rules this convention layers on top of.
- **The mailbox is not a hardened channel.** Anyone who learns the mail
  address can attempt to send it mail; the allowlist, the content pattern
  match, and the 10-minute single-use TTL together are what stand between
  that and a stolen code being useful. This is the same trade-off any
  email-based 2FA channel carries, mitigated as far as an inbox this narrow
  can be.
