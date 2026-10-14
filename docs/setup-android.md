# Setting up the Android companion app

The companion app ("Healthy Companion", `dev.maxhogan.healthy.companion`, in
[`android/`](../android)) reads the Health Connect data on an Android phone in
the background and uploads it to _your own_ Healthy Worker. The Worker keeps a
sealed copy, so an assistant connected over MCP can answer questions about it
with the phone switched off.

**What it is.** A small app that holds a read-only Health Connect grant, wakes
up every 15 minutes, uploads what changed since the last time, and shows its own
status on screen.

**What it is not.**

- It does not write to Health Connect, and it has no account, sign-in or
  server of its own. The only network destination it has is the Worker origin
  you paired it with.
- It has **no analytics, no crash reporting and no third-party SDK that phones
  home**. Nothing about you, the phone or what it read goes anywhere but your
  Worker.
- It is not a source of record. Health Connect stays the source; the Worker's
  copy is a read-only cache of it, like the copy of the health system records.

It needs **Android 17** (API 37) or newer, where Health Connect is part of the
platform, and a deployed Worker that has been through
[setup-cloudflare.md](setup-cloudflare.md), including the Access bypass for the
upload path.

## 1. Install the app

The app is not on a store. Every push to `main` builds a signed APK and
publishes it as a GitHub release, and [Obtainium](https://obtainium.imranr.dev/)
installs and updates it from there.

1. Install Obtainium on the phone.
2. Open this link on the phone (or paste it into Obtainium's **Add app** box):

   ```
   obtainium://add/https://github.com/pmaxhogan/healthy
   ```

3. Choose **Add**, then **Install**. Obtainium picks the release asset named
   `healthy-companion-<version>.apk` (the repo's `android/obtainium.json` carries
   that filter) and will offer each new release as an update.

Without Obtainium, download the same APK from the repository's **Releases**
page and open it; Android asks once to allow installs from that source. A fork
publishes its own releases from its own keystore (see [Releasing](#releasing)),
so use your fork's link, not this one.

A release is cut on every push to `main`, including a push that only touches the
Worker. Expect more updates than the app has changes.

## 2. Pair the phone

1. In the admin UI, open the **Phone** page, give the phone a name and press
   **Pair a phone**.
2. The page shows a QR code and, under it, the same text as a **Pairing code**
   (with a **Copy pairing code** button), **once**. The pairing code is exactly what
   the QR encodes: the server's address, the device id and the device token. Neither
   is stored anywhere and neither can be shown again; if you lose them, press
   **Rotate token** on the phone's card (see
   [Revoking, rotating, deleting](#7-revoking-rotating-and-deleting)). Press
   **I have paired the phone** when you are done.
3. In the app, tap **Pair**, then **Scan QR code** (the app asks for the camera
   permission the first time), and confirm the server address it shows
   (**Pair with `<host>`?**).

The code carries the Worker's address (the origin of the page you are looking
at), the device id and the device token. The app refuses a plain `http` address,
because a bearer token must not cross an open network: a release build takes
`https` and nothing else, and cleartext traffic is switched off in it altogether.
Only a **debug** build also accepts `http://localhost` or `http://127.0.0.1`, the
phone's own loopback (the local-testing setup below). The token
is stored encrypted under an AES-GCM key in the Android Keystore that cannot be
exported, and the app opts out of cloud backup and device transfer, so neither a
copy of the app's data folder nor a restore yields it.

The scanner is CameraX with ZXing, decoding frames on the phone and never
storing or sending them. It is not Google's code scanner, because the Google
scanners bundle usage reporting and this app has none. The app also accepts the
pairing code as pasted text, in a box labelled **Pairing code (JSON)** (then **Use
pasted code**) that wants the whole JSON the QR encodes, which is what the Phone
page's **Pairing code** field holds. That is how an emulator pairs, or a phone
whose camera is no use. The pasted text holds the token, so it is kept in memory
only: it is cleared once used, refused or when you leave the screen, and it is not
saved across the app being killed or the screen being recreated.

## 3. Grant Health Connect access

The app asks for read access to every record type Health Connect has. Use
**Grant all** on the status screen, or open Health Connect, **App permissions**,
**Healthy Companion**, and allow everything. Three grants are easy to miss and
matter:

- **Background access** (_Read in the background_ in the app, _Background read_
  on the Phone page). Without it the app can read only while it is open, and the
  15-minute cadence does nothing.
- **Access to past data** (_Read history older than 30 days_ in the app, _History
  read_ on the Phone page). Without it Health Connect limits the app to a window
  of recent data (about the last 30 days from the moment of the first grant), so
  the full-history backfill cannot reach further back. If you grant it after a
  backfill already ran without it, those types start over to reach their real first
  record. The same holds if the permission is withdrawn part-way through a
  backfill: months read after that come back empty, so every unfinished type
  stops claiming full history and is redone once the permission is granted again
  (a type that had already finished with full history is left alone).
- **Exercise routes.** The permission dialog does not offer these alongside
  "Allow all", so **Grant all** does not settle them: use **Open Health Connect**
  on the app's permissions card and allow them there. They are not a record type;
  the app reports them as a field of their own, which the Phone page shows as
  _Exercise routes_ beside _Background read_ and _History read_.

A record type you decline is not silently dropped. The app reports it as **Not
granted**, the Worker records it as **not permitted**, and every answer that
would have included it says so, so an assistant never mistakes "you did not let
me read it" for "there is nothing there". A type the phone's own Health Connect
does not offer at all is reported **Unavailable**, which the Worker treats as
not applicable rather than as a refusal. Granting a type later takes effect on
the next sync.

Also allow notifications: the app uses them for the backfill's progress and to
tell you when syncing keeps failing. It does not ask by itself; the **Allow
notifications** button on the status screen does.

## 4. Let it run in the background

Android stops background work on apps it considers idle, and takes permissions
away from an app nobody opens. Two exemptions stop both. While either is missing
(or notifications are not allowed), the status screen shows a **Running in the
background** card:

- **Exempt from battery optimisation** opens the system prompt; or open
  **Settings, Apps, Healthy Companion, Battery** and choose **Unrestricted**. The
  Phone page shows whether the phone reported it (_Battery exemption_).
- **Keep permissions when unused** opens the system screen where "remove
  permissions if app is unused" (hibernation) is switched off for this app.
  Without that, Android withdraws the Health Connect grants of an app that has not
  been opened for a few months, and syncing stops without a word.

Some phone makers add a second, vendor-specific "auto-start" or "app launch"
setting; if a phone goes quiet despite the exemptions, check there.

## 5. What the status screen shows

The screen is a stack of cards:

| Card                           | What is on it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Server**                     | The host it is paired with and the device id. **Pair** when not paired; otherwise **Pair again** and **Unpair**. Unpairing forgets the server and the token and stops uploads; what was already uploaded stays on the Worker until it is deleted there.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Sync**                       | _Status_ (Idle, Syncing, Backfilling, or "Backfilling, waiting to retry"); _Last sync_, the last run that fully succeeded; _Waiting to upload_, changes read from Health Connect and not yet acknowledged by the Worker; _Full backfill_ (Not started, Running, Paused or Complete, with "N of M type-months done"; a Paused backfill also says why, with the error of the type that stopped it, which stays until that type's backfill gets somewhere again); _Last error_, the app's own sentence about it, then the stable code, when, and how many runs in a row, never a payload. While a backfill is waiting out a failure the card also says when it will try again, and that it will go sooner if the connection comes back. After a rejected pairing the error says to pair again. Separately from the last error, a background run that read nothing because the background-read grant is missing shows "Background syncs are being skipped" with the reason (`background_read_missing`) and when; it is a standing reason, not an error, and it clears on the next run that reads. |
| **Sync**, buttons              | **Sync now** uploads immediately; pulling the screen down does the same, and so does opening the app. **Full backfill** starts or resumes the full-history read; once it is complete the same button reads **Run full backfill again**, and asks for confirmation first, because it re-reads and re-uploads all of history (hours of data and battery; the Worker replaces each record by its id, so nothing is duplicated). It resets each granted type's backfill position and its uploaded count, first and last dates and rejected and stubbed counts, so the re-upload rebuilds them instead of counting twice; the change cursors are not reset, so incremental sync carries on undisturbed. Both buttons are off while something is already running. **Upload on Wi-Fi only** waits for an unmetered network; off by default.                                                                                                                                                                                                                                                          |
| **Health Connect permissions** | _Record types_ ("N of M granted"), _Read in the background_, _Read history older than 30 days_ and _Exercise routes_, with **Grant all** and **Open Health Connect**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Running in the background**  | Only while something is missing: **Exempt from battery optimisation**, **Keep permissions when unused** and **Allow notifications**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Coverage by record type**    | Per type: Granted, Not granted or Unavailable, the first and last record dates, and how many records have been uploaded. A type with records that did not arrive as themselves also shows, only while the count is above zero, "N rejected" (records the Worker refused one by one) and "N stubbed" (records too large, uploaded as stubs). Those counts are kept for good, reported to the Worker with every upload, and reset only by **Run full backfill again**. All 41 record types the app reads are listed, including the ones you declined. Exercise routes are not a record type: they are a separate permission, shown on the permissions card and reported to the Worker as a top-level `exerciseRoutes` field of the state report.                                                                                                                                                                                                                                                                                                                                                |

At the bottom are the app version and **What this app does with your data**, the
privacy screen Health Connect also opens from its permission dialog.

## 6. How syncing works

- **Every 15 minutes**, on any network, at any battery level. It is WorkManager's
  periodic work, and Android holds such work back for reasons of its own (while
  the phone dozes, and for every app while the phone is hot), so a watchdog stands
  behind it: an alarm set for 17 minutes after every sync that starts. It only goes
  off when the periodic work did not run in time, and then asks for the same sync
  as expedited work, which Android is far more willing to run in those situations
  (not always: a phone hot enough holds everything back). The alarm is
  inexact (no "alarms and reminders" access is asked for) and is on time while the
  phone dozes only for an app exempt from battery optimisation (step 4). The
  schedule and the alarm are put back when the phone restarts, when the app is
  updated and whenever the app starts. There is no permanently running service.
  After the first sync
  the app reads only what changed, through Health Connect's change feed, one
  cursor per record type. A cursor Health Connect has expired is replaced by a
  re-read of the last 30 days; duplicates are harmless because every record is
  stored by its id. A record deleted while its cursor was expired cannot be
  learnt that way. **Sync now**, the Tasker action and opening the app run at
  once and ignore the low-battery condition, but still honour **Upload on Wi-Fi
  only**.
- **A sync that is cut off is finished first.** Android can stop a sync part-way
  (the network drops for a moment, the job runs out of time). The record types are
  read in an order that starts one type further round on every sync, so that none
  is always last; a sync that did not get through them all is followed by one that
  starts with the type it had reached, instead of one further round. Every upload
  also says which sync it belongs to and what started it (the schedule, the
  watchdog, the owner, opening the app, or the backfill), and how the sync before
  it ended, so the Worker can tell a sync that was cut off from one that had
  nothing more to send.
- **Sessions are also read by time.** For sleep, exercise and mindfulness sessions
  every sync also reads the last 48 hours by time, and uploads any session the
  Worker has not acknowledged in its current form (the app remembers the id and
  last-modified time of what it sent, so an unchanged session is not sent again).
  A session the change feed failed to report therefore still arrives within one
  sync. Series such as heart rate are never re-read this way. A record that Health
  Connect reports as both changed and deleted in the same answer (an app that
  deleted it and wrote it again under the same id) is uploaded, not deleted.
- **Acknowledge, then commit.** The app advances its cursor only after the Worker
  answers 200, and "200" means the batch was validated and durably queued. A batch
  that fails is sent again, never dropped, and a replay is recognised by its batch
  id (derived from the batch's own bytes) and not applied twice. Every upload also
  carries the phone's state report (permissions, battery exemption, backfill
  progress, last error), so the Worker learns about a refused type even when
  there is no data to send.
- **Batches.** The app aims for about 1 MiB compressed, 6 MiB of JSON and 20,000
  items per batch; the Worker's own caps are 8 MiB, 16 MiB and 25,000. Nothing
  limits how much is uploaded in total.
- **What the Worker's answers do.**

  | Answer                              | The app                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
  | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 200                                 | Acknowledged. A `rejected` count (records the Worker refused one by one) is added to that type's **Rejected** count in the coverage table, reported to the Worker, and shown as the last error `records_rejected`; the cursor still moves.                                                                                                                                                                                                                                                                                                                                             |
  | 401                                 | Stops, shows `unauthorized`, posts a notification, and sends nothing until it is paired again. Pairing again, even with the same code, lifts it: the app tries once and finds out.                                                                                                                                                                                                                                                                                                                                                                                                     |
  | 409                                 | The batch id was already used for different content and nothing was applied. The same content is sent again under a fresh random id; if that is refused too, the run fails with `batch_id_conflict`.                                                                                                                                                                                                                                                                                                                                                                                   |
  | 413                                 | Too large: the batch is halved and tried again. A single record too big even alone is uploaded as an envelope-only stub instead (see below).                                                                                                                                                                                                                                                                                                                                                                                                                                           |
  | 429 (`rate_limited`, `backlogged`)  | Waits for `retry-after`. Inside a scheduled run it waits at most 90 seconds and then ends the run; the next try is the periodic sync's own 15-minute schedule, not a WorkManager backoff. The backfill backs off for as long as it takes, up to 15 minutes between tries.                                                                                                                                                                                                                                                                                                              |
  | 400                                 | Never taken to mean that one record is bad: nothing is skipped or split and no cursor moves (halving is for 413 only). The same batch has been sent once; the app then sends one empty batch with the same envelope to tell the cases apart. If that is accepted (200), the refusal was about that one body: that record type fails for the run as `bad_request` and the other types carry on. If it is refused with 400 too, every batch would be, and the run stops. If it meets a 5xx, a 429 or no reply, the run fails and is retried; if it meets a 401, the pairing is rejected. |
  | 415                                 | Handled exactly like a 400 (one empty probe decides), with the error code `unsupported_media_type`: a bug in the app, which a retry does not fix.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
  | 5xx, a timeout, anything unexpected | The batch is kept and tried again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

  **One oversize record does not block its type.** A record that is over the Worker's
  limits even on its own is uploaded as an envelope-only stub: its id, type, origin and
  times and a note of how large it was, with none of its data, so the gap is visible on
  the Worker instead of everything behind it waiting. A stub is counted apart from the
  records the Worker accepted (the type's **Stubbed** count, shown in the coverage
  table while it is above zero and reported to the Worker), and the type reports
  `record_oversize_stubbed`.

  After **three failed runs in a row** the app posts a "Health data is not
  syncing" notification with the app's sentence and the last error code; a 401
  posts one at once, and a background run skipped for want of the background-read
  grant posts one the first time only.

  A scheduled run never asks WorkManager to retry. A periodic job that returned
  "retry" would run again after WorkManager's own backoff (up to hours) instead of
  at its period, so the 15-minute period itself is the retry: each run starts from
  the last acknowledged position. Retries within a run (up to three tries per
  batch) stay in the app.

- **Platform aggregates.** Alongside the records, for nine metrics (steps,
  distance, active calories, floors, elevation, wheelchair pushes, exercise
  duration, sleep duration, hydration) the app asks Health Connect for its own
  totals per UTC hour, which de-duplicate overlapping apps, and uploads them as
  records of type `Agg.<Metric>` (for example `Agg.Steps`). They are not counted
  in the per-type _Uploaded_ numbers. A record's change comes with its times, so
  the hours it touches are worked out again in the same upload; a deletion does
  not (Health Connect says which record went, not when it was), so on one the app
  works out again only the last 30 days. The server knows when a deleted record
  was, and every answer to an upload names the hours whose stored total it now
  holds out of date; each sync then works some of those out again, at most eight
  requests of Health Connect a run, and uploads them, so deleting months of an
  app's history is repaired over the next few syncs. An hour leaves the list once
  the upload carrying its total has been acknowledged.
- **Backfill.** **Full backfill** is started by you; it is not automatic. It
  reads all of history as a foreground service with a visible notification,
  **newest month first** (UTC calendar months), so recent data is useful within
  minutes. Progress is saved per record type, month and page, so stopping it (or
  the phone restarting) resumes where it left off, and a scheduled sync restarts
  it after the process was killed (Android allows that from the background only
  for an app exempt from battery optimisation; otherwise it shows **Paused**
  until you open the app). It does not restart it while the server has refused
  the phone's token, and not for a backfill that gave up on its remaining types
  until you press the button again. The change cursors are taken _before_ the backfill
  starts, so nothing that changes during it is missed. The foreground service is
  of type `health`, which Android lets start only while at least one of the heart
  rate, skin temperature or oxygen saturation read permissions is granted; if none
  is, or the system refuses the start, the
  backfill shows **Paused** with the error `backfill_not_started`. A Paused
  backfill names the error of the type that stopped it beside "Paused, N of M
  type-months done", and that error stays until that type's backfill gets
  somewhere again. With **Upload
  on Wi-Fi only** on, it waits for an unmetered network. Keep the phone **plugged
  in and on Wi-Fi** for it: years of history is a lot of data, and Health Connect
  rate-limits readers, so the app backs off when it is told to and carries on.
  When a step fails, the backfill waits and tries the same step again, and says so:
  the status reads "Backfilling, waiting to retry", with the error and the time of
  the next try. A wait caused by a lost connection ends the moment a network is back
  instead of running out its backoff. The button is always available: once the
  backfill is complete, **Run full backfill again** (after a confirmation) reads and
  uploads the whole history once more, which is the way to recover when the Worker
  turns out to be missing something. It resets each granted type's backfill cursor,
  its uploaded count, first and last dates and its rejected and stubbed counts, so
  the re-upload rebuilds them rather than counting twice; it does not reset the
  change cursors. The Worker applies batches in the background,
  so the Phone page shows a queue draining after the phone has finished, and rollups
  and summaries filling in while it does. The page refreshes itself every 15
  seconds while it is on screen: the phone's card says how many of the granted
  types have finished (_Backfill: 9 of 14 types complete_), and **Show details**
  says how far back each unfinished type has reached and counts the uploads that
  are queued, being applied and applied.
- **Tasker.** If you use Tasker, the app is a plugin with one action, **Trigger
  refresh**, which queues the same sync as **Sync now**. It is optional; nothing
  else depends on it.

## 7. Revoking, rotating and deleting

All three are on the Phone page, under the phone's card, and all three need the
admin gate (Access and the password session).

| Action                    | What it does                                                                                                                                                                                                                           | Use it when                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Rotate token**          | Mints a new token and invalidates the old one at once. The stored data stays. Shows a new QR code and pairing code, once.                                                                                                              | You lost the QR, suspect the token leaked, or want to re-pair the phone. |
| **Revoke**                | The token stops working, so nothing new is accepted. Batches the Worker had already queued are still applied. The stored data stays and stays readable through MCP, and its coverage reads `stale`. A revoked phone cannot be rotated. | The phone is lost or retired but its history should stay.                |
| **Delete phone and data** | Deletes the device and all of its stored data: records, rollups, the queue and the upload log. You type the phone's name to confirm (**Delete everything**). Cannot be undone.                                                         | You want the Worker to forget this phone entirely.                       |

The phone's own copy in Health Connect is never touched by any of them.

A revoked phone's stored data is **still served** over MCP until it is deleted, so
an assistant keeps answering from it, labelled stale. If you pair the same physical
phone again as a new device without deleting the old one first, both copies of its
history are served and an answer can count everything twice; the tools say so with a
`multiple_devices:<n>` warning when rows come from more than one phone. To avoid it,
delete the old phone and its data when you pair the phone again as a new device.

## Troubleshooting

- **The Phone page says "never uploaded".** The phone is not paired, has no
  network, or has not run yet: press **Sync now**.
- **The app reports `unauthorized` (401), or "This phone's pairing was rejected".**
  The Worker will not say which of "unknown", "wrong" or "revoked" applies, by
  design. After a rotation or a revocation the old token is dead: pair again
  (**Pair again**, scan the new QR code or paste the new pairing code). Pairing
  again always lifts the app's block, even with the very same code, and costs one
  request to find out whether it now works. Re-pairing to the same device keeps the
  app's sync progress. A revoked phone cannot be rotated: use **Pair a phone** on the
  Phone page to pair it as a new one, which is what the app's message says.
- **The phone is shown as stale.** No upload has arrived for six hours. Check, in
  order: the phone is on and online, the app has background access and the battery
  exemption (both shown on its card), and the last error. Pressing **Sync now**
  usually settles it. A stale phone's data is still served, labelled stale.
- **A record type says "not granted".** That is not an error. A type you did not
  allow is listed as such, in grey, under **types with no data**, and is left out
  of the backfill count. If you do want it collected, allow that type in Health
  Connect, **App permissions**, **Healthy Companion**.
- **Uploads answer 429.** `rate_limited` is a per-device limit and `backlogged`
  means the Worker still has a lot of that phone's data to apply. The app waits
  as told and retries; there is nothing to do but wait. See
  [operations.md](operations.md#the-phone-and-health-connect) if it persists.
- **Backfill stopped.** If the status says "Backfilling, waiting to retry" it is
  only waiting out an error (the card says which, and when it will try again) and
  carries on by itself, sooner when a lost connection comes back. If it shows
  **Paused**, open the app and press **Full backfill**; it resumes where it left
  off. Check the phone is charging, that notifications are allowed (the backfill
  runs as a foreground service with a notification), and that the app holds at
  least one of the heart rate, skin temperature or oxygen saturation permissions;
  without one, the error is `backfill_not_started`. If the error is
  `unauthorized`, the backfill stays stopped, and is not restarted by a scheduled
  sync, until you pair again.
- **The Phone page says uploads "could not be applied and are being kept".** The
  Worker accepted them, but could not apply them. Nothing is deleted: they are set
  aside with the error code, and the uploads behind them carry on. Fix the cause
  and press **Retry** on the phone's card, which also puts back any rollup or summary that was set aside. See
  [operations.md](operations.md#when-the-queue-backs-up).
- **The last error, or the line beside "Paused", shows a code you do not recognise.**
  The app shows its own sentence with the code beside it (the code is what the
  Phone page and the logs say). Every code, with what to do:

  | Code                      | What the app says, and what to do                                                                                                                                                                                                                                                                                                                                                                                     |
  | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `unauthorized`            | "This phone's pairing was rejected." The Worker refused the token (unknown, wrong, rotated or revoked; it will not say which). Pair again from the Phone page, as a new phone if this one was revoked. Pairing again lifts the block.                                                                                                                                                                                 |
  | `background_read_missing` | "Health Connect only lets this app read while it is open." A background run without the background-read grant read nothing. Allow reading in the background (step 3), or open the app to sync. Shown as "Background syncs are being skipped", apart from the last error.                                                                                                                                              |
  | `no_permissions`          | "No Health Connect record type is granted, so there is nothing to sync." Use **Grant all**.                                                                                                                                                                                                                                                                                                                           |
  | `backfill_not_started`    | "Android would not start the backfill." Keep the app open and try again; it needs the heart rate, skin temperature or oxygen saturation permission.                                                                                                                                                                                                                                                                   |
  | `hc_unavailable`          | "Health Connect did not answer, or is not available on this phone." The run did not guess; it is tried again on the next sync.                                                                                                                                                                                                                                                                                        |
  | `hc_rate_limited`         | "Health Connect's read quota is used up for now." Syncing resumes by itself when it refills.                                                                                                                                                                                                                                                                                                                          |
  | `hc_remote`               | "Health Connect stopped answering part-way." Tried again on the next sync.                                                                                                                                                                                                                                                                                                                                            |
  | `hc_io`                   | "Health Connect could not read its data." Tried again on the next sync.                                                                                                                                                                                                                                                                                                                                               |
  | `hc_error`                | "Health Connect reported an error." Tried again on the next sync.                                                                                                                                                                                                                                                                                                                                                     |
  | `hc_invalid_argument`     | "Health Connect refused the request for this type." That type stops for the run and is tried again on the next sync.                                                                                                                                                                                                                                                                                                  |
  | `network`                 | "The server could not be reached." Nothing is lost; it is tried again, and a backfill carries on the moment a network is back.                                                                                                                                                                                                                                                                                        |
  | `bad_request`             | "The server could not read an upload." Nothing was skipped (no record is dropped and no cursor moves); it is sent again on the next sync. If it keeps happening, update the app.                                                                                                                                                                                                                                      |
  | `unsupported_media_type`  | "The server refused the upload's format." Nothing was skipped. Update the app or the server.                                                                                                                                                                                                                                                                                                                          |
  | `payload_too_large`       | "The server found an upload too large even after it was split." That type waits; nothing was skipped.                                                                                                                                                                                                                                                                                                                 |
  | `record_too_large`        | "A record is too large to send and could not be reduced." That type waits.                                                                                                                                                                                                                                                                                                                                            |
  | `record_oversize_stubbed` | "A record was too large to upload." A placeholder with its times and size was sent instead; see the type's **Stubbed** count.                                                                                                                                                                                                                                                                                         |
  | `records_rejected`        | "The server refused some records it could not read." They are counted under **Rejected** for their type; the cursor moved.                                                                                                                                                                                                                                                                                            |
  | `batch_id_conflict`       | "The server had already seen an upload id with different content." It is sent again under a fresh id.                                                                                                                                                                                                                                                                                                                 |
  | `pairing_changed`         | "The pairing changed while a sync was running." The next sync uses the new one.                                                                                                                                                                                                                                                                                                                                       |
  | `aggregate_failed`        | "Health Connect could not compute its hourly totals for a type." The records themselves were uploaded.                                                                                                                                                                                                                                                                                                                |
  | `permission_denied`       | "Health Connect refused to let this app read a type." Check its permission in Health Connect.                                                                                                                                                                                                                                                                                                                         |
  | `changes_token_unstable`  | "Health Connect keeps expiring this type's change marker." The last 30 days were re-read; it is tried again.                                                                                                                                                                                                                                                                                                          |
  | `page_token_invalid`      | "Health Connect lost its place while paging through a type." The read was started over once; that type is tried again on the next run.                                                                                                                                                                                                                                                                                |
  | `rate_limited`            | "The server asked the phone to slow down." It waits and carries on.                                                                                                                                                                                                                                                                                                                                                   |
  | `backlogged`              | "The server is still working through earlier uploads." The phone waits and carries on.                                                                                                                                                                                                                                                                                                                                |
  | `bad_response`            | "Something other than the server answered" (a sign-in page or a network portal). Nothing was taken as sent.                                                                                                                                                                                                                                                                                                           |
  | `state_store_failed`      | "The app could not save its own sync position on this phone." Nothing is lost: what was sent is sent again. If it keeps happening, free up storage or restart the phone.                                                                                                                                                                                                                                              |
  | `hc_page_too_large`       | "A batch of very large records did not fit in memory." It is read again in smaller pieces.                                                                                                                                                                                                                                                                                                                            |
  | `waiting_for_wifi`        | "The backfill is waiting for Wi-Fi", because uploading on Wi-Fi only is switched on.                                                                                                                                                                                                                                                                                                                                  |
  | `internal_error`          | "The app hit an unexpected error." Tried again on the next sync.                                                                                                                                                                                                                                                                                                                                                      |
  | `backfill_state_invalid`  | "The saved backfill position for a type was unreadable." Run the full backfill again.                                                                                                                                                                                                                                                                                                                                 |
  | `unknown_record_type`     | "The app asked Health Connect for a type it does not know." Update the app.                                                                                                                                                                                                                                                                                                                                           |
  | `sync_failed`             | "The sync failed." A run failed with no more specific code; it is tried again on the next run.                                                                                                                                                                                                                                                                                                                        |
  | `http_<status>`           | Any other status. 5xx: "The server reported an error of its own"; nothing is lost, it is tried again. 3xx: the address redirected instead of answering; check the address the phone is paired with. 403, 404 or 405: something in front of the server refused the upload; check that `/ingest/health-connect` bypasses Cloudflare Access. Anything else: the server answered unexpectedly; nothing was taken as sent. |

## Building from source

You need JDK 21, the Android SDK with platform 37.2 (the build compiles against
it; install it with `sdkmanager` or Android Studio), and nothing else: the
Gradle wrapper is committed.

```sh
cd android
echo "sdk.dir=/path/to/Android/Sdk" > local.properties   # or set ANDROID_HOME; gitignored
./gradlew assembleDebug                                   # app/build/outputs/apk/debug/
./gradlew testDebugUnitTest lintDebug                     # what the Android CI job runs
```

A debug build installs beside the release app (its id has a `.debug` suffix), so
the two can coexist. The Android build is **not** part of `npm run check`; it has
its own CI job, and the Worker's gate and deploy never run Gradle.

### Local end-to-end test

Run the whole loop against a local Worker, with the real phone, before pushing
anything:

```sh
npm run migrate:local
npm run dev:worker        # wrangler dev on :8787
npm run dev               # the admin UI, for the Phone page
adb reverse tcp:8787 tcp:8787
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Mint a device on the local Phone page and scan its code: the pairing address is
`http://localhost:8787`, which the phone's `adb reverse` carries to your
machine. Only a **debug** build accepts plain `http`, and only for loopback; a
release build refuses it. Local D1 is inspectable with
`npx wrangler d1 execute healthy --local --command "..."` from `worker/`. If you
save the phone's payloads to look at them, save them under the gitignored `.local/`
and never copy them into the repository.

**Granting the permissions from `adb`.** On a development phone, `pm grant` can
give the debug build a Health Connect read permission without going through the
permission dialog, which saves tapping through it on every reinstall:

```sh
adb shell pm grant dev.maxhogan.healthy.companion.debug android.permission.health.READ_STEPS
```

This was observed to work for the health permissions on one Android 17 device; it is
a convenience for development, not something the app relies on, and it has not been
checked on other devices or Android builds. Use the app's own **Grant all** and the
Health Connect screen when it does not work.

### Releasing

A release is built by `.github/workflows/release.yml` on every push to `main`
(skipped when `HEAD` already carries a release tag), on a daily schedule, and on
demand (the daily run exists because a merge made with the workflow's own token, as
Dependabot's auto-merge does, does not start push-triggered workflows). It accepts
the Android SDK licences, so that Gradle can download a platform the runner image
lacks, runs the unit tests and Android lint (it does not wait for CI, so it gates itself), then builds the APK, signs it and checks the signature.
The version is `android/VERSION` (`major.minor`) plus the repository's commit count
as the patch; the release tag is `v<major>.<minor>.<patch>` and the APK is
`healthy-companion-<major>.<minor>.<patch>.apk`. The version code gives the minor
two digits and the patch four, so the build refuses a minor above 99 or a patch above
9999 rather than produce a code that could collide with another release.

The APK is signed with the v2 and v3 schemes; v3 is what allows the signing key to be
rotated later without every install having to be removed first.

The workflow signs the APK with a keystore you create once and keep outside the
repository:

```sh
keytool -genkeypair -v -keystore release.jks -alias healthy \
  -keyalg RSA -keysize 4096 -validity 10000
```

Store its contents and passwords as four **repository secrets** (Settings,
Secrets and variables, Actions):

| Secret              | Value                              |
| ------------------- | ---------------------------------- |
| `KEYSTORE_BASE64`   | The keystore file, base64-encoded. |
| `KEYSTORE_PASSWORD` | The keystore's password.           |
| `KEY_ALIAS`         | The key's alias (`healthy` above). |
| `KEY_PASSWORD`      | The key's password.                |

The workflow decodes the keystore into a temporary file and fails at that step,
saying `KEYSTORE_BASE64 is not set`, when the secret is missing or empty (the secret is passed to that step through the environment, never written into the script text), rather
than letting Gradle fail later with a keystore error that names no cause. It hands
the file to Gradle through four environment variables, which a local release build
can set the same way:

```sh
export HEALTHY_KEYSTORE_PATH=/path/to/release.jks
export HEALTHY_KEYSTORE_PASSWORD=...
export HEALTHY_KEY_ALIAS=healthy
export HEALTHY_KEY_PASSWORD=...
./gradlew assembleRelease
```

Without `HEALTHY_KEYSTORE_PATH` the release build is simply unsigned. **Keep the
keystore and its passwords safe and private**: Android refuses to update an app
signed with a different key, so losing it means every phone must uninstall and
pair again. Never commit it; it belongs in a password manager.
