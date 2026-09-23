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
   `mail_sender_allowlist` setting. The match is **anchored at a label
   boundary**: an entry allows that exact domain, or a subdomain of it, and
   nothing else. Entries have to be domain-shaped with at least two labels
   (`mailAllowlistSchema`). The shipped default is `google.com` alone —
   Gmail's forwarding-verification sender — and the health system's own
   sending domain is the owner's to add on the Mail page, because a real one
   names an organisation and so cannot have a default in source.

   This used to be substring containment with a shipped `mychart.` fragment,
   which allowlisted every domain on the internet whose own label happened to
   contain it (`mychart.attacker.example`, `google.com.attacker.example`) —
   i.e. it let anyone who could reach the inbound address post verification
   codes of their own choosing. Anything not allowed is
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

`mail_inbox` (added by the migration that also adds the portal-sync tables,
extended by `0005_mail_sealed_metadata.sql`): `id`, `received_at`,
`from_addr_enc` and `subject_enc` (both sealed), `kind`
(`otp` | `forward_verify` | `other`), `code_enc` (sealed; null for `other`),
`consumed_at`, `expires_at`, and `raw_size`. No message body is ever stored,
at any kind.

**Everything a sender chose is sealed.** `from_addr` and `subject` were
plaintext columns until 0005. For a forwarded portal message the first is the
health system's own sending address and the second its own subject line — an
organisation identity and message content, and both attacker-chosen on the
reject path. They are now sealed (padded, so the ciphertext's length does not
give the address or the subject away) with the AAD bound to
`mail_inbox.from_addr_enc.<id>` / `mail_inbox.subject_enc.<id>`. The two old
plaintext columns were blanked by migration 0007 and dropped by 0009.

**Every kind has a TTL**, not only `otp`: 10 minutes for `otp`, 6 hours for
`forward_verify`, 24 hours for `other` (including the `POST /api/mail/test`
row). `purgeExpired` additionally deletes anything older than 7 days whatever
its `expires_at` says, and it runs from the daily cron as well as after each
inbound message — so collection does not depend on mail continuing to arrive.

## Reading a code back out: the repo's two entry points

- **`takeFreshOtp({ since, now, expectedSender, allowlist })`**, used by the
  portal sign-in flow: claims the **oldest eligible** unconsumed, unexpired
  `otp` row received after the sign-in attempt's own `SendCode` time, and
  marks it consumed in the same `UPDATE ... RETURNING` statement. Two callers
  racing each other (a retry racing the original attempt) can never both
  claim the same code — the loser's `UPDATE` matches no row.

  **Eligible** means "from a sender this health system's codes come from".
  `portal_accounts.otp_sender_enc` holds that domain, set by the owner (the
  portal card, or `npm run set-portal-credentials -- --otp-sender`) or learned
  from the first code the portal itself accepts; while it is unset the sender
  allowlist stands in. Without that binding nothing tied a row to the sign-in
  that asked for it, so one message per poll interval from anyone beat every
  genuine code — and oldest-first is the other half: the portal's own code is
  the one that arrived closest behind `SendCode`.

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
  cannot be replayed later. Every other kind expires too, and nothing at all
  survives 7 days.
- **A claim is bound to a sender.** Only the health system's expected sending
  domain (or, until one is known, the allowlist) is eligible, and the oldest
  eligible row wins — so a flood of attacker-sent codes cannot be submitted
  to the owner's portal, nor outrun the real one.
- **Sealed metadata.** The sender, the subject and the code are all
  application-layer encrypted; a D1 snapshot names no health system.
- **No bodies stored, ever.** Only the four fields listed above survive
  parsing, for every kind, including `other`.
- **Never logged.** `handleInboundEmail` logs whether the sender was allowed
  (a boolean), the classification, the message size, and (on acceptance) the
  row's id — never the address, never the domain, never the subject, never a
  code. The domain used to be logged: for a forwarded portal message it is the
  health system's own sending domain, which `SECURITY.md` puts in the
  never-hand-to-the-logger category, and on the reject path it is a string an
  unauthenticated remote sender chooses. The redactor now also drops any field
  named after a host, a domain or an origin, so a future caller cannot
  reintroduce it. See `worker/lib/log.ts` and `SECURITY.md`.
- **The mailbox is not a hardened channel.** Anyone who learns the mail
  address can attempt to send it mail; the allowlist, the content pattern
  match, the sender binding, and the 10-minute single-use TTL together are
  what stand between that and a stolen code being useful. This is the same trade-off any
  email-based 2FA channel carries, mitigated as far as an inbox this narrow
  can be.
