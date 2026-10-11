# The MCP server

Healthy exposes the aggregated record over the Model Context Protocol,
Streamable HTTP, at `/mcp`. It is OAuth-protected, every tool is read-only
(`readOnlyHint`), and every call passes through one server-side filter
before anything is serialised — see [SECURITY.md](../SECURITY.md) for why
that design exists. This page covers connecting a client, the consent flow,
the exposure policy's exact syntax, the audit log, and revoking access.

## Tools

The server registers (in `worker/src/mcp/tools/index.ts`): `get_health_summary`,
`list_health_systems`, `get_sync_status`, `get_patient_profile`,
`get_appointments`, `get_encounters`, `get_conditions`, `get_medications`,
`get_medication_fills`, `get_allergies`, `get_immunizations`,
`get_lab_results`, `get_vitals`, `get_social_history`, `get_procedures`,
`get_diagnostic_reports`, `get_documents`, `get_document_text`,
`get_messages`, `get_message_thread`, `get_message_attachment`, `get_care_team`, `get_care_plans`, `get_goals`, `get_devices`,
`get_coverage`, `get_service_requests`. Most accept an optional
`health_systems[]` filter and an optional `raw` flag that additionally returns
the underlying FHIR resource (filtered by the same policy as the normalised
one). Eleven more read a paired phone's Health Connect data — `hc_coverage`,
`hc_sync_status`, `hc_records`, `hc_aggregate`, `hr_series`, `hr_events`,
`sleep_sessions`, `exercise_sessions`, `blood_pressure`, `daily_summary`,
`data_quality` — and are described under
[Health Connect](#health-connect-the-paired-phone) below. The admin UI's MCP
page (`/connectors`) lists the live catalogue.

Every answer is the same envelope:
`{ items, total, matched, coverage, warnings, truncated, generatedAt }` (plus `raw` when
asked for). `total` is how many items the exposure policy let through;
`matched` is the output count — how many values `jq` emitted (below), before
`limit`; without `jq`, the number of items `limit` applies to (`total`, or
`groups` after `get_conditions`' `collapse`). `truncated` is true only when a
caller-supplied `limit` cut something — or, on the Health Connect tools alone,
when their soft byte budget did, in which case a `cursor` says where to
continue.

### Filtering server-side with `jq`

Every tool, `get_document_text` included, takes an optional `jq` argument: a
real jq program (jq 1.8.2) run on the server before the answer is returned,
so a model can ask for exactly the slice it needs instead of reading a whole
history. For example, on `get_lab_results`:

```json
{ "jq": ".[] | select(.effective >= \"2026-01-01\") | {code, value, effective}" }
```

- **Order.** Exposure policy, then the tool's own post-policy step (only
  `get_conditions`' `status` filter and `collapse`), then `jq`, then `limit`.
  jq only ever sees what
  the policy released: a denied field is simply absent (`.[].deniedField` is
  `null`), and a denied resource type or health system is not in the input.
- **Input.** The `items` array. With `raw: true` each item also carries its
  policy-filtered FHIR resource under `raw` (`.raw.resource`), and the
  separate `raw` array is not returned, since a program that filters or
  reshapes `items` would leave it misaligned.
- **Output.** The filter runs on the items array; every value it emits becomes
  one element of `items`, even a single one. A stream such as
  `.[] | select(...) | {...}` therefore puts one match per `items` element —
  the usual thing to want. Wrapping it in `[...]` instead (`[.[] | select(...)]`)
  produces one output, itself an array, so `items` ends up with that one array
  as its single element (`[[...]]`), not the flat list; use the unwrapped form.
  `limit` always applies to the `items` array, however many outputs `jq`
  produced.
- **Dates.** Every date the tools return is an ISO-8601 string, so plain
  string comparison (`>=`, `<`) orders them correctly.
- **Honesty.** A compile or runtime error is a tool error, `jq_error`, whose
  `detail` is jq's own message — never an empty result. When a non-empty input
  produces no outputs, or only `null` ones, the answer carries the warning
  `jq_result_empty`, so the model re-checks its filter before concluding the
  data is not there.
- **Cost bounds** (on the program, never on the data): the program may be at
  most 4096 characters; it runs with a step budget (`jq_budget_exceeded` when
  it runs out — in practice only a filter that never terminates, like
  `[repeat(1)]`) and a 64 MiB memory ceiling (`jq_out_of_memory`); nothing is
  ever truncated. See [SECURITY.md](../SECURITY.md#jq-cost-bounds).
- **Large answers.** jq's parsed form of JSON is six to ten times its text, so
  64 MiB holds roughly 6 MB of items at once, and a few hundred exercise
  sessions with GPS routes are several times that. A program that starts with
  `.[] |` — the form above — does not need the array: it is run over the items
  a piece at a time (about 2 MiB of JSON each, never splitting an item) and its
  outputs are concatenated, so it has no such limit and
  `.[] | [.start, .end]` over any number of records of any size returns one
  element per record. The program is not rewritten (each piece is itself an
  array and the caller's text runs on it as written), and the answer is the one
  a single run would give: the same outputs in the same order, the same
  `matched`, `limit`, byte budget and `jq_result_empty`, and on an error the
  same message about the same item with nothing returned. The step budget is
  one for the call, not one per piece (100 million units plus 100 per byte of
  items, of which parsing uses about 8; measured in Node, 290 MB of
  route-bearing items in 150 pieces took 7.5 s with jq's memory flat at
  19 MiB). A program is run this way only when
  everything after that first pipe stays inside its own item, which is decided
  conservatively from its text: the names `input`, `halt`, `debug` and `stderr`
  anywhere after the pipe (they read the input stream, stop the whole run, or
  write to the stream an error is read from) send it the other way, as does
  anything that does not start `.[] |`.
  A program that needs the whole array — `length`, `sort_by(...)`,
  `group_by(...)`, `map(...)`, `[.[] | ...]`, `first(.[] | ...)`,
  `.[] as $x | ...` — is run once over all of it, exactly as before, and has to
  fit: past the ceiling it fails `jq_out_of_memory`, whose `detail` says to
  project with `.[] | ...` and count or sort the small result, to narrow the
  call, or (on `hc_records`) to leave the large field out with `fields`. A
  single item too large for jq on its own fails the same way and says so.
- **Examples, per tool.** Each tool's `jq` argument description carries one
  shared sentence and then one to three examples written against that tool's
  own item fields (`worker/src/mcp/jq-examples.ts`). A unit test
  (`worker/test/unit/mcp/jq-examples.test.ts`) runs every one of them through the
  real tool and the real jq engine over a synthetic record and fails if any
  stops compiling or stops matching anything.

**Engine.** jq-wasm (jq 1.8.2 built with Emscripten), vendored under
`worker/src/mcp/jq/vendor/` by `worker/scripts/build-jq-wasm.mjs`, which adds fuel
metering and the memory ceiling with Binaryen. It was chosen over a jaq
(Rust) wasm build — no wasm32 toolchain on the build machine, and a
not-quite-jq dialect — and over pure-JavaScript interpreters, which cannot be
interrupted once a synchronous loop starts. Measured in Node 26 on synthetic
lab items: 1.04 MB wasm (361 KB gzipped); a fresh instance per call costs
~0.5–1 ms; a call takes ~1 ms on 4 KB of input, ~8 ms on 470 KB and
~40–60 ms on 2.3 MB; metering adds ~10–15%.

### Date windows: `from` and `to`

The tools that take a window compare it against one date field of each item
(`worker/src/mcp/collect.ts`, `bound` and `inWindow`):

- **Both ends are inclusive.** An item dated exactly `from` or exactly `to` is
  kept.
- **A date without a time is a whole UTC period.** `from: "2026-01-31"` starts
  at `2026-01-31T00:00:00.000Z`; `to: "2026-01-31"` runs through
  `2026-01-31T23:59:59.999Z`, so the whole last day is included. `2026-01`
  and `2026` work the same way for a month and a year (`to: "2026-01"` is the
  end of January).
- **An instant without an offset is UTC.** `2026-01-31T09:00` means 09:00Z.
  The server does not know the owner's timezone and never assumes one; to mean
  a local day, pass instants with their offset
  (`from: "2026-01-31T00:00:00+HH:MM"`).
- **Only ISO-8601 is accepted** (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`, or a
  date-time with optional seconds, fraction and `Z`/`±HH:MM`). Anything else is
  a schema error, never a guess.
- **Items are compared as instants.** An item's own date is parsed as written;
  a date-only item date (`2025-10-01`) is midnight UTC of that day.
- **Missing dates.** An item without the tool's field falls back to its
  `lastUpdated` (when the health system last changed it); an item with no
  usable date at all is left out of any windowed call, and kept when there is
  no window.

| Tool                                                  | Windows on                                 |
| ----------------------------------------------------- | ------------------------------------------ |
| `get_appointments`                                    | `start` (default `from` is now, see below) |
| `get_encounters`                                      | `start`                                    |
| `get_conditions`                                      | `recorded`, else `onset`                   |
| `get_medications`                                     | `authoredOn`                               |
| `get_medication_fills`                                | `whenHandedOver`                           |
| `get_immunizations`                                   | `occurrence`                               |
| `get_lab_results`, `get_vitals`, `get_social_history` | `effective`, else `issued`                 |
| `get_procedures`                                      | `performed`                                |
| `get_diagnostic_reports`                              | `effective`, else `issued`                 |
| `get_documents`                                       | `date`                                     |
| `get_care_plans`                                      | `period.start`                             |
| `get_goals`                                           | `startDate`                                |
| `get_service_requests`                                | `occurrence`                               |
| `get_messages`                                        | `sent`                                     |

The other tools take no window (a `from` passed to them is a schema error).
`get_health_summary` in particular is always "nearest to now".

### Freshness: `coverage` and `get_sync_status`

Every tool that reads a resource type answers with `coverage`: one entry per
(health system, resource type) it read, with a `status` of `ok`, `partial`
(one category of a category-split search was refused), `stale` (no success in
36 hours), `failed` (with `errorCode` and `errorMeaning`), `unsupported` or
`never`. An entry whose last refresh recorded a code that is more than
informational carries it under `notices` as `{code, count, meaning,
severity}`; the informational ones (4101, 4119, 59204) are left out there, as
they are on nearly every search.

`get_sync_status` is the detail behind all of it, and it has many rows: one
`kind: "health_system"` row per health system, then one `kind:
"resource_sync"` row **per resource type per health system** — a couple of
dozen per health system. A `resource_sync` row is:

| Field                            | Meaning                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `healthSystem`, `healthSystemId` | Which health system                                                                    |
| `resourceType`                   | The FHIR type                                                                          |
| `status`                         | The same vocabulary as `coverage`                                                      |
| `lastFullAt`                     | Last successful full refresh (ISO instant), or null                                    |
| `lastOk`                         | Whether the last attempt succeeded                                                     |
| `lastErrorCode`, `lastError`     | The last attempt's error code, and `{code, meaning, severity}` for it (or null)        |
| `warnings`                       | Every code the health system reported last time, as `{code, count, meaning, severity}` |

Filter it with `jq` rather than reading every row — the tool's own `jq`
description has examples: only the rows that are not `ok`/`unsupported`, only
rows with a non-`info` warning, and one line per health system.

**`unsupported`** means the health system's FHIR server does not offer that
resource type to patient apps (its CapabilityStatement leaves it out), so it
is never searched. It is harmless and is never reported as a gap. Specimen is
the common one. No tool returns specimens — lab results come from Observation
and DiagnosticReport — so an unsupported Specimen takes nothing away from any
tool.

#### What the codes mean

Severity is what a code means for someone reading the cache, not Epic's own
Fatal/Warning/Information label: `info` — expected, everything that could be
returned was; `warning` — something was left out or deferred; `error` — the
type (or that attempt) could not be read; `unknown` — no documented meaning,
reported as such rather than guessed. The table lives in
`worker/src/sync/sync-state-codes.ts`. Epic's free-text `diagnostics` is never
stored or shown: it can echo the search's parameters.

**Sources.** "Epic table" is the "FHIR Error Codes" table Epic publishes at
the foot of every R4 API specification on fhir.epic.com (for example
AllergyIntolerance.Search), read 2026-09-28. 59204 is not in it: its meaning
comes from Epic's own `details.text` seen on a live search ("Client not
authorized for <Type> - Outside Record") and from Epic's "(Outside Record)" API
specifications, which describe that variant as data the health system received
from payers, other providers or other FHIR servers.

| Code                                                                                           | Severity | Meaning                                                                                                                                      | Source                                           |
| ---------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `4101`                                                                                         | info     | The search matched nothing.                                                                                                                  | Epic table                                       |
| `4119`                                                                                         | info     | Epic's note on every patient-authorized search: additional data may exist, as a patient's view may not be the complete record.               | Epic table                                       |
| `4117`                                                                                         | info     | An immunization came back without a CVX code; it is still included.                                                                          | Epic table                                       |
| `4122`, `59100`                                                                                | info     | An unknown search parameter was ignored.                                                                                                     | Epic table                                       |
| `59109`                                                                                        | info     | An optional search parameter was invalid and ignored.                                                                                        | Epic table                                       |
| `59204`                                                                                        | info     | Not authorized for the type's "Outside Record" variant (payer and outside-organisation data); the health system's own records were returned. | Live `details.text`; Epic's Outside Record specs |
| `4113`                                                                                         | warning  | Epic's paged-search session expired; the refresh restarts it once.                                                                           | Epic table                                       |
| `4127`, `59133`                                                                                | warning  | The search matched more than Epic returns, so more may exist.                                                                                | Epic table                                       |
| `4134`                                                                                         | warning  | The record is restricted (break-the-glass); some data may be withheld.                                                                       | Epic table                                       |
| `4135`                                                                                         | warning  | The daily document-download cap was reached; the rest are fetched another day.                                                               | Epic table                                       |
| `59101`                                                                                        | warning  | A parameter value (e.g. a category) was not recognised; that part may have returned nothing.                                                 | Epic table                                       |
| `4100`, `4102`–`4104`, `4110`–`4112`, `4115`, `59102`, `59108`, `59111`                        | error    | The request was invalid or the resource could not be built; nothing was returned for it.                                                     | Epic table                                       |
| `4118`                                                                                         | error    | The health system refused this app access to this data.                                                                                      | Epic table                                       |
| `4130`, `4131`                                                                                 | error    | Break-the-glass security withheld the data.                                                                                                  | Epic table                                       |
| `59001`, `59205`                                                                               | unknown  | Seen from Epic; not in Epic's published table and no text was captured.                                                                      | —                                                |
| `category_rejected:<cat>`                                                                      | warning  | That category of a category-split search was refused while the others succeeded (coverage `partial`).                                        | This server                                      |
| `unsupported`                                                                                  | info     | The health system does not offer the type (above).                                                                                           | This server                                      |
| `upstream_error[:<epic>]`, `upstream_auth`, `upstream_unavailable`, `needs_reauth`, `internal` | error    | The attempt failed; with an Epic suffix, the suffix's meaning applies.                                                                       | This server (`worker/src/lib/errors.ts`)         |

### Appointments: FHIR and the patient portal

Epic's patient-facing FHIR view does not return an Encounter until a visit
has happened, so the only record of an _upcoming_ appointment is the patient
portal. The hourly portal pass stores every visit the portal's upcoming list
returns (all of its buckets, however far ahead) in `portal_visits`, sealed
like the FHIR cache, and `get_appointments` merges those with the cached
Encounters:

- **One visit, one item.** A portal visit and an Encounter for the same
  health system are the same appointment when their CSNs match, or — when either
  side has no CSN — when their starts are within five minutes and both name the
  same practitioner (the calendar sync's own dedupe rule). A shared start time
  alone is not enough: a cancelled Encounter would otherwise absorb a different,
  live visit at the same time. The answer then carries the FHIR item, with any
  field it lacks (practitioner, department, location, end, visit type)
  filled from the portal's copy, and never both.
- **Every item says where it came from**: `source: "fhir"` or
  `source: "portal"`. A portal item has the same flat shape as a FHIR one
  (`start`, `end`, `status`, `visitType`, `practitioner`, `department`,
  `location`, `telehealth`, `csn`, `health_system`) but no `encounterId`, since
  there is no Encounter behind it. Its `status` is the portal's own word
  (`scheduled`, `confirmed`, `canceled`, …); a future visit the portal has
  stopped listing is reported as `canceled`, mirroring the grey "Cancelled"
  event on the calendar.
- **What only the portal knows.** Read each hourly pass with the session it
  already holds — the upcoming list itself, plus one read-only GET of each
  visit's details page — and stored sealed with the visit. Each field is
  _absent_ when unknown (a FHIR-only visit, or a copy stored before it was
  read) and `null` when the portal says it does not apply to that visit:
  - `confirmed`: `true`/`false`; `null` when there is nothing to confirm.
  - `getReady`: the pre-visit tasks (eCheck-in), `{ complete, stepsRemaining }`;
    `null` when not offered.
  - `payment`: `{ kind, amount, amountDue, amountPaid, paid }` in US dollars,
    `kind` being `copay`, `prepay`, `balance` or `null`; `amount` is what is due
    while unpaid and what was paid once paid. `null` when the portal names no
    payment for the visit.
  - `waitlist`: `{ enrolled }` for the earlier-appointment wait list
    (`enrolled: null` when the list is offered but its state could not be
    read); `null` when the visit offers none.
  - `directions`: the department's directions, with the health system's
    boilerplate removed — a paragraph two different departments' directions
    both carry is the health system's, not the department's. Only applied
    once the health system has stored at least three visits with directions,
    across at least two practitioners and two departments; below that nothing
    is removed. `visitInstructions`: the visit's own instructions, as written.

  A FHIR item merged with a portal copy takes these from it too. The calendar
  shows only the directions and instructions (first, under the "Synced by
  Healthy" line), and links the visit line to that visit's own page in the
  portal when the portal lists it first-hand.

- **Window and order.** With no arguments the window is "from now", with no
  upper bound, soonest first — every upcoming visit the portal lists is
  returned, up to `limit` (default 50). `includePast: true` or an explicit
  `from` widens the window into the past, and the answer is then newest
  first. `to`, `health_systems` and `limit` apply to portal items exactly as to
  FHIR ones.
- **Policy.** Portal items are tagged `resourceType: "Encounter"`, so a
  `resource` rule on `Encounter`, a `health_system` rule, and every
  `Encounter.<field>` rule reach them through the same choke point.
- **`raw: true` never carries the portal payload.** Its keys are in neither
  vocabulary a `field` rule is written in, so a rule meant to hide, say, an
  address could not be relied on to reach it. A portal item's `raw` entry is
  a bare `{ "resourceType": "Encounter" }` placeholder (one per item, so
  `items` and `raw` stay aligned), and the answer carries the warning
  `portal_items_have_no_raw`.

- **One visit, one item, across organisations.** A portal can list visits
  booked at _other_ health systems the account shares records with, so the
  same visit can arrive from two health systems. Two sightings from different
  health systems are one visit when their starts are within five minutes and they
  share a CSN, or name the same practitioner, or — when no practitioner
  disagrees — the same department or location (all compared after
  normalising case, punctuation, word order and credentials). Time alone
  never merges two visits, so two different appointments at the same time
  are both kept. The copy that answers is, in order: a FHIR Encounter; a
  portal copy that does not say it is another organisation's; one that does;
  a portal copy not refreshed for two days (its portal is failing). Nothing
  is ever dropped for being second-hand: when the owning organisation has no
  copy — not connected, or failing — the second-hand one is kept, marked
  `firstParty: false` and `via: <health_system id>` (the portal it was seen in).
  Every other item carries `firstParty: true`. Whether a visit is
  second-hand is read from the portal's own markers, which no captured
  payload has shown yet; without one a visit counts as first-hand. The
  calendar sync applies the same rule, so such a visit gets one event; a
  second-hand event already on the calendar when the owner's copy turns up
  is deleted — not ghosted, since the visit is not cancelled.

`get_health_summary`'s appointments section uses the same merge: the five
appointments nearest to now, upcoming ones first (soonest first), then the
latest past ones.

### Secure messages: the patient portal's Message Center

Each hourly portal pass, after the upcoming visits and with the same session
(never a sign-in of its own), reads every conversation in every Message
Center folder — conversations, appointments, automated letters and notices,
archive, bookmarked — of every organisation the portal shows, every page, and
every message in each conversation, older pages included. It never opens a
conversation the way the portal's own page does (that marks it read), and
stores each message in `portal_messages`: the body as plain text (the portal's
HTML is flattened, never kept), sealed and padded like the FHIR cache, keyed
by a blind of its content rather than the portal's per-session ids.
`portal_message_sync` records how each health system's last read went.

The same pass then fetches every attachment it has not stored yet: the
Message Center's own attachment link asks for the file's document details
(`GetDocumentDetailsLegacy`) and downloads the file they name, relative to the
portal's mount. It has to be the same run, because the portal names a file only
by a per-session token. Every file is kept whole, sealed and padded in
`portal_message_attachment_chunks` (base64, cut into pieces that each fit one
D1 value), under a key derived from the message's content and the file's
position in it, so a later run knows it is already stored. There is no size
limit. A file on a message the portal still marks unread is left until the
message has been read (whether the download marks a message read has not been
observed, and the owner's unread messages must stay unread); a download that
fails is recorded with its error code and tried again a day later; a session
that ends mid-pass leaves the rest for the next run.

- **`get_messages`: one item per conversation**, newest activity first
  (`kind: "message_thread"`): `threadId`, `subject`, `folder`,
  `firstMessageAt`, `lastMessageAt`, `messageCount`, `unreadCount` (the
  portal's own unread flags, read without marking anything read; absent for
  messages stored before the flag was kept), `attachmentCount`,
  `hasAttachments`, `practitioners[]` (the care team), `participants[]`
  (everyone who wrote in it: `role` — `patient`, `proxy`, `practitioner` or
  `system` — and `name`), `lastMessage` (`id`, `sent`, `direction`, `from`,
  and `preview`: the newest message's first 160 characters, whitespace
  collapsed, with `previewTruncated`), and the health system tags. `total` is
  the conversations; the envelope's `messages` is how many messages they hold.
  `from`/`to` window on `lastMessageAt` and keep a conversation whole;
  `folder` filters; `search` keeps conversations whose subject or any
  message's full text contains the given text, ignoring case and spacing.
- **`get_message_thread`: one conversation, every message in full**
  (`kind: "message_thread_detail"`): the same conversation fields and
  `messages[]`, oldest first — `id`, `sent`, `direction` (`from_patient` /
  `to_patient`), `from`, `unread`, `body` (plain text), `attachments[]`
  (`name`, `extension`, `id`, `status` — `stored`, `failed` with `errorCode`,
  `waiting_until_read` or `not_fetched` — and, once stored, `contentType` and
  `size`), and `noLongerListed` where it applies.
- **`get_message_attachment`: one attached file**, by the `id` a message's
  `attachments[]` reported (`kind: "message_attachment"`): its metadata and
  status, and its content where it can be shown — a text file (plain text,
  HTML, RTF, converted exactly as `get_document_text` converts them) as `text`;
  an image a model can view (PNG, JPEG, GIF, WebP) as an MCP image content
  block beside the JSON, only when the policy releases the item's `image`
  field; anything else (a PDF, a TIFF scan) as its type and size with a `note`,
  never as base64. It reads storage only; it never talks to a portal. A conversation whose messages come from
  two health systems' portals (one has a reply the other has not listed yet) is
  one item per health system, in both tools.
- **One message, one item, across organisations.** Each portal also shows the
  conversations of the other organisations the chart is linked to, so one
  message can be stored twice. Two copies are one message only when they carry
  the same content — the same delivery instant to the second, the same author
  role, the same text; time alone never merges two messages. The copy that
  answers is the one whose own organisation the conversation belongs to
  (`firstParty: true`); a second-hand copy is kept, with `firstParty: false`,
  `via` and `organization`, only when no first-party copy is stored (the same
  ranking as visits, including the two-day staleness rule). `threadId` and
  `id` are the same from either portal.
- **Never deleted.** A first-party message its portal stops listing is kept
  with `noLongerListed: true`; a second-hand one is never flagged, because a
  linked organisation can drop out of the Message Center for a while with no
  error at all.
- **Policy.** The policy judges each message on its own, before any grouping:
  both tools read one item per message (`resourceType: "Communication"`,
  the rule builder's "Secure message" shape), filter those, and only then
  group what the policy released into conversations (`respond()`'s reshape,
  `worker/src/mcp/message-threads.ts`). So a `resource` rule on Communication
  removes every conversation and the coverage, and every
  `Communication.<field>` rule on a message field (`body`, `from.name`,
  `subject`) reaches the participants, previews, bodies and search built
  from it. `from.name` and `practitioners[].name` are names of people, judged
  like any reference, one message at a time: a clinician's name goes
  wherever the owner withholds clinicians' names (a denied Practitioner type,
  a `Practitioner.name` rule, a rule on an Encounter's `practitioners`), the
  patient's wherever the patient's name is withheld — and hiding one never
  takes the other with it. The policy then runs over the conversation items
  too, so a rule on their own fields (`lastMessage.preview`,
  `messages[].body`, `participants`) reaches them. `search` matches only what
  the first pass released: to keep bodies out of search, hide the message
  field `body`, not only `messages[].body` in `get_message_thread`. The body is
  prose and is not scrubbed (see SECURITY.md's known limits). There is no
  `raw`.
- **Coverage** is `Communication` per health system, from the portal pass's own
  record: `failed` with the error code when the last read failed (for example
  `portal_session_expired`), `partial` when it could not prove it saw
  everything, `stale` after six hours without a successful read.

### Conditions: the problem list and encounter diagnoses

An Epic record re-mints a diagnosis as a new Condition at every visit it is
coded at ("encounter diagnosis", tagged with both the FHIR
`encounter-diagnosis` category and Epic's own `visit-diagnosis`), next to the
handful of problem-list entries — so the raw list is mostly the same few
conditions again and again, and most of those rows carry no clinical status.
`get_conditions` keeps every row (no arguments still returns all of them) and
makes the useful view one argument away:

- **`category`** — a list; a row is kept when it is in any of them:
  `problem-list-item`, `encounter-diagnosis`, `health-concern`. The display
  strings (`"Problem List Item"`, `"Encounter Diagnosis"`, `"Health Concern"`)
  and Epic's `"Visit Diagnosis"` are accepted and mapped; anything else is
  refused. Matched against the category codes, displays and text of the raw
  resource and the normalized `category`, compared as slugs.
- **`status`** — the clinical status (`active`, `resolved`, …, compared as a
  slug), or `unknown` for exactly the rows that have none. A status filter
  that leaves out rows with no status says how many:
  `status_filter_excluded_unknown:<n>`. It runs after the exposure policy, so
  a hidden `clinicalStatus` reads as unknown rather than being filtered on.
- **`collapse: true`** — one item per condition (`kind: "condition_group"`).
  Identity is the health system plus the row's first ICD-10 code, else its
  first SNOMED code, else its text (lower-cased, whitespace collapsed); a row
  with none of those is a group of its own. ICD-10 comes first because a
  problem-list entry and its visits' copies reliably share it, while which
  coding a health system sends _first_ differs between them — so every row's
  normalized `code` carries all its codings as `code.codings`. A group has the
  representative row's `code`, `clinicalStatus`, `verificationStatus` and
  `abatement` (the problem-list row when there is one, else the latest row
  with a status), `categories` (the union, as codes), `onProblemList`,
  `firstSeen` / `lastSeen` (the earliest and latest onset or recorded date —
  every cached encounter diagnosis carries a recorded date, so the visit's own
  date is not read separately), `occurrences`, `ids` (the Condition ids) and
  `encounterIds` (each visit named, once). Groups are newest `lastSeen` first.
- **Counts.** `total` is the rows after the policy and the filters, before
  grouping; `groups` (only with `collapse`) is how many groups, and it is the
  groups that `jq` and `limit` see, so `matched` and `truncated` are about
  groups. With `raw: true`, `raw[i]` is the list of group `i`'s rows' resources.
- **Policy first.** Grouping runs on what the exposure policy released: a
  hidden `onset` does not feed `firstSeen`, a hidden `encounterId` (or a denied
  Encounter type) leaves `encounterIds` empty, and a hidden `code` leaves every
  row its own group. A rule on `code.code` or `code.system` (or the raw
  `code.coding[].code` / `.system`) reaches every entry of `code.codings`, not
  just the first coding. The policy then runs over the groups once more, so a
  rule on a group's own field (`Condition.firstSeen`, `Condition.encounterIds`)
  applies too.

`get_health_summary`'s conditions section is the same collapse: problem-list
entries first, then the most recently seen encounter diagnoses, then anything
else, each labelled `source: "problem_list" | "encounter_diagnosis" | "other"`.

### Health Connect: the paired phone

A phone paired on the admin UI's **Phone** page uploads its Health Connect
records in the background ([setup-android.md](setup-android.md)). They are a
source of their own, beside the health systems and never merged into them:
`get_vitals` stays what a clinic measured, and eleven tools read the phone.

| Tool                | What it answers                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hc_coverage`       | Per record type that has data: `availability`, first and last record, count, typical cadence, the apps that wrote it. Call it first.                                      |
| `hc_sync_status`    | Per phone: last upload, backlog, backfill, battery-optimisation exemption, queue depth, recent failed uploads. Then one row per type that has data.                       |
| `hc_records`        | Raw records of one `type` in a range, exactly as stored.                                                                                                                  |
| `hc_aggregate`      | One `type` in calendar buckets (`hour`, `day`, `week`, `month`, `year`, `<N>min`), duplicates between apps handled.                                                       |
| `hr_series`         | Heart rate as a series: `resolution` `raw`, `5s`, `1min` (default), `5min`, `1h`.                                                                                         |
| `hr_events`         | Sustained rises in heart rate, with baseline, peak, time to peak and a `context`.                                                                                         |
| `sleep_sessions`    | One row per night: stage minutes, the wearable's wake and the heart-rate-checked wake, overnight heart rate, HRV, respiratory rate, skin temperature, resting heart rate. |
| `exercise_sessions` | Workouts, overlaps merged, with heart rate, energy, distance, steps and `likelyLeftRunning`.                                                                              |
| `blood_pressure`    | Readings, duplicates dropped, grouped into sittings with their means and the cuff's pulse.                                                                                |
| `daily_summary`     | One row per local day joining all of the above.                                                                                                                           |
| `data_quality`      | Duplicates, artefacts, gaps, source switches and precision changes in a range, with every threshold.                                                                      |

`get_health_summary` carries three `kind: "phone"` items per phone: its last
upload (`section: "sync"`), its newest blood-pressure reading and last night's
sleep.

**Rows and the envelope.** The envelope is the usual one, plus `timeZone`,
`units` and, when rows were cut, `cursor`. Every row is tagged
`healthSystemId: "device:<id>"` and `resourceType: "hc:<Type>"` (the Health
Connect record class without `Record`: `hc:HeartRate`, `hc:SleepSession`),
which is what `coverage`, the warnings and the exposure policy key on. Numbers
are numbers; a unit is declared once per field in `units`, never on a row.
These tools take `devices` (a `device:<id>` or part of the phone's name) where
the others take `health_systems`, and have no `raw` flag: `hc_records` is the
raw view. Without `devices`, every paired phone answers, revoked ones
included: revoking a phone keeps its data. So a phone that was paired again
without the old pairing's data being wiped answers twice and doubles every
total; an answer whose rows come from more than one phone warns
`multiple_devices:<n>`, and `devices` is the way to pick one.

**Times.** `start` and `end` are a calendar date (`2026-01-31`, that whole
local day) or an instant that carries its offset (`2026-01-31T09:00:00-05:00`,
`...Z`); a date-time with no offset is refused, not guessed at. Ranges are
half-open, `[start, end)`, and `end` defaults to now. "Local" means the zone
of the `tz` argument, or the owner's `timezone` setting when it is omitted;
the answer names the zone it used in `timeZone`, day, week and month buckets
begin at that zone's midnight (so a day is 23 or 25 hours across a clock
change), and every returned time is ISO-8601 with that zone's offset: the
times of records and buckets, and the bookkeeping instants of `hc_coverage`
and `hc_sync_status` (`lastUploadAt`, `pairedAt`, `receivedAt`) and the
phone's `sync` item in `get_health_summary` alike. Every tool that takes a
range refuses one whose `end` is before its `start` (`invalid_range`) rather
than answer it empty. `daily_summary` takes `date` for one day or `start` and
`end` for a range, and today with neither; `end` without `start`, `date`
beside a range and an `end` that is not after `start` are `invalid_range`
too, with `detail` saying which.

**The byte budget.** These eleven tools stop at a soft budget of 25,000 bytes
of serialised rows. This is the one place the server limits an answer on its
own, a deliberate exception to "a tool returns everything it was asked for":
a day of heart rate at one-minute resolution is megabytes. It is soft in both
senses. It cuts at a row boundary and never below one row; it always says so,
with `truncated: true` and a `cursor`; and the caller lifts it by passing a
larger `max_bytes`, which has no maximum. To continue, repeat the call
changing only `cursor` (`limit` and `max_bytes` may change too). A cursor is
bound to the question that produced it, and is refused (`invalid_cursor`) if
anything else changes. It is also bound to the phone's data as it stood: a
continuation recomputes the answer and skips what was already sent, which
only lines up while nothing moved. All eleven tools check that: once an
upload has arrived or been applied, or a rollup rebuilt, a cursor is refused
with `cursor_expired` and the caller starts again without one.
`hc_records` is the exception to "recomputes": its cursor carries the start
time of the next row, so a continuation reads the store from there, returns
exactly the rows a single call would have, and reports the whole answer's
`total` and `matched` on every page. An answer from these tools is sent as
compact JSON (no indentation), and the budget counts those bytes: what is
measured is what is sent. The budget is measured on what `jq` emits, so a
projection such as `.[] | [.t, .mean]` fits several times as many rows in a
page; there is no columnar or CSV mode, because that is what `jq` is for.
`hr_series` has a second, separate ceiling, `max_points` (default 2000 per
series): a longer series is made coarser rather than cut short, by moving it
to the next width of a fixed ladder that fits (2, 5, 10, 15, 30 minutes; 1,
2, 3, 6, 12 hours; 1, 2, 7, 14, 28 days), always a whole multiple of the
resolution asked for. Each series (one per phone and app) is resampled on its
own, and `series` in the answer lists each one's `bucketMs`, `decimated`,
`decimation`, `totalPoints` and `points`, in the order the series appear in
the rows. The top-level `bucketMs` and `decimation` are given only when every
series shares them and are null otherwise; `hr_series_decimated:<factor>`
warns with the largest factor.

**What a phone has, and what it does not.** These tools talk about data, not
about permissions. A record type is there when the store holds at least one
record of it, and absent when it holds none:

- A type with no stored records is **not mentioned**: no `coverage` entry, no
  warning, no row in `hc_coverage`, no `type_sync` row in `hc_sync_status`, no
  place in any count, nothing in `daily_summary`, `data_quality` or the
  summary. It makes no difference why there are none. The owner may not have
  the device that would record it, may have chosen not to let the companion
  app read it, or the phone may not offer it; in every case the honest answer
  is that this data does not exist here, and that is usually by design.
- The first record stored makes the type appear everywhere, with nothing to
  configure: the rule reads the store's own record counts.
- A type **asked for by name** is always answered. `hc_records`,
  `hc_aggregate`, `hc_coverage` with `types`, `data_quality` with `types`,
  and the tools that are about one type (`hr_series` and `hr_events` are
  heart rate, `blood_pressure`, `sleep_sessions`, `exercise_sessions`) answer
  with empty `items`, a `coverage` entry of `ok` with `recordCount: 0`, and
  the warning `no_data:hc:<Type>:device:<id>`. The answer is the same
  whatever the reason there is nothing. A name that is no record type at all
  answers `unknown_type:hc:<Type>` instead.
- Whether the phone may read a type is not exposed to a client in any field,
  notice or warning. The owner sees and manages that on the admin Phone page.

For a type that does have records, `hc_coverage`'s `availability` is one of:

| `availability` | Coverage `status`          | Meaning                                                                  |
| -------------- | -------------------------- | ------------------------------------------------------------------------ |
| `ok`           | `ok`                       | There are records, and the phone uploaded within six hours.              |
| `stale`        | `stale`                    | There are records, but no upload for six hours; they are still returned. |
| `no_data`      | `ok` with `recordCount: 0` | Only for a type the caller named: there are no records of it.            |

`stale` produces the usual `stale:hc:<Type>:device:<id>:<n>h` warning. It is
about the phone, not the type: a phone that has stopped uploading goes stale
on every type it has data for, including one it may no longer read. Ages
(`hoursSinceUpload`, `staleHours`, `ageHours`) are never negative: an upload
stamped a moment after the answer's `generatedAt` is zero hours old.
`hc_store_pending:device:<id>` means uploads are still
being applied (or rollups rebuilt), so the newest one may not be in the answer
yet. `hc_batches_parked:device:<id>:<n>` means `n` uploads could not be
applied and are set aside: their records are missing from every answer until
they are queued again, and `hc_sync_status` reports the count as
`parkedBatches`. `hc_rollups_parked:device:<id>:<n>` means `n` rollups or
session summaries could not be rebuilt and are set aside; a figure answered
from them may be missing or out of date. That is not "pending" (nothing is
working on them) and does not stop the day rollups being used.

**Whose numbers: `origin_mode`.** Several apps write the same thing to one
Health Connect store, and adding everything up counts a walk twice.
`hc_aggregate` (and `daily_summary`, which uses it) therefore says whose
numbers each bucket holds, in the row's `method` and `origins`:

- `hc_priority` (the default). The phone uploads Health Connect's own
  priority-merged hourly totals for the types the platform aggregates (steps,
  distance, active calories, floors, elevation, wheelchair pushes, hydration,
  exercise and sleep duration). A bucket that has them is answered with them
  (`method: "platform"`). Where there are none the answer falls back, by what
  the type is:
  - A sensor's running count (steps, distance, active and total energy,
    floors, elevation, wheelchair pushes) is decided **hour by hour**: in each
    UTC hour the one app with the largest total is taken, and the hours are
    summed into the bucket (`"max_origin"`). The hour is the unit whatever the
    bucket size, so a month is the sum of its days and of its hours in every
    zone, and an app that recorded the first half of a month does not erase
    the app that recorded the second. `duplicatesDropped` counts only another
    app's records in an hour the chosen app also recorded in.
  - Sleep and exercise are answered from the stored sessions, grouped by the
    session rules (`"merged_sessions"`): two apps writing the same workout
    are one and the extra copies are counted in `duplicatesDropped`, two
    different workouts are two. For exercise, `duration` is the platform's
    where its hours span every session of the bucket; `records` is always the
    number of stored sessions.
  - Everything else is every app merged (`"all_origins"`): a measurement such
    as heart rate or weight, and an entry someone logs (a drink, a meal),
    since two entries from two apps are two entries.

  A bucket the platform covers only part of is composed hour by hour
  (`"platform_and_max_origin"`, `"platform_and_all_origins"`). The answer
  warns `hc_priority_fallback` when any bucket fell back and
  `hc_duplicates_dropped:<n>` with the total.

- `origin:<package>`: that app's records alone.
- `all_separately`: one row per bucket per app.

A record counts in the bucket its **start** falls in, whole (`bucketing:
"start_time"`). A night of sleep is the one exception: it counts in the
bucket it **ended** in, the day you woke up (`bucketing: "end_time"`), which
is the `date` `sleep_sessions` gives it and the day `daily_summary` puts it
on. For that reason sleep is never answered from the platform's hourly
figure, which would split a night at midnight. Empty buckets are returned with `hasData: false`, filled with
zero or, with `fill: "null"`, null (a mean or an extreme of nothing is null
either way). Nothing dated after now is counted unless `exclude_future` is
false. Total calories are what was recorded: Health Connect pads unrecorded
hours with basal metabolic rate, which turns "no data" into a plausible
number, so that padding is off unless `bmr_fill: true`, and then shown per row
as `bmrFillKcal`. `answeredFrom` says which level of the store was read:
whole local days come from day rollups, whole hours from hour rollups, and
only a sub-hour bucket or the ragged edge of a range opens raw records
(`session_summary` for sleep and exercise). Day rollups answer a type unless
that type's days in the range are waiting to be rebuilt or a change of zone
is under way.

`hc_aggregate` applies the artefact rules below to the types that have one
(heart rate, speed, weight) unless `exclude_artefacts` is false. It never
does so silently: each row says how many values were left out
(`artefactsExcluded`) and the answer warns `hc_artefacts_excluded:<n>`. Only
the hours a rollup shows could hold an artefact are opened to find them.

**Rules applied when answering.** The store keeps everything the phone sends;
duplicates and artefacts are handled when a question is answered, and counted
in the answer. They live in one module, `worker/src/hc/rules.ts`: a
blood-pressure reading written twice (the same time to the nearest second, the
same values to 0.1 mmHg) is counted once; heart-rate samples above 200 or
below 20 bpm and speeds above 15 m/s are left out; a weight written within a
minute of a height record by the same app is a profile screen, not a weighing;
overlapping sleep or exercise sessions are one row; an exercise session over
three hours is `overThreeHours`, and one of those that also ends in resting
heart rate and no steps is `likelyLeftRunning`. A flag takes a value out of a figure, never out of a
listing: `daily_summary`'s `weight` is the last weighing that was not flagged,
and its `weighings` lists every one with the `flag` it earned. `daily_summary`
adds one rule of its own: a "resting heart rate" written by an app within a
minute of its own blood-pressure reading is the cuff's pulse and is excluded.
`data_quality` lists what each rule found.

A merged session row is described by ONE session, the longest of its group
(among equally long ones the one carrying the most figures, then the lower
app name): `start`, `end`, `durationMin` (or `inBedMin`), heart rate, steps
and energy are all that session's, so they describe the same span. The
stretch the whole group covers is beside them in `spanStart`, `spanEnd` and
`spanMin`, and `members` lists every session the row stands for, so nothing a
merge absorbed disappears. The row's `id` and each member's `id` are the
session records' own ids, the ones `hc_records` returns for `SleepSession` and
`ExerciseSession`, so a row or a member can be looked up there (`null` only
for a record deleted on the phone whose summary has not been rebuilt yet).
Which row a session is in is read off `members` or the span, never off
`start`/`end`: a member that only partly overlaps the longest one sticks out
of them. Not everything that overlaps is merged: two
exercise sessions of different `exerciseType` are two activities, and a
session that is `likelyLeftRunning`, an exercise session longer than 12 hours
or a sleep session longer than 18 is never merged with anything but an exact
copy of itself. A session nobody stopped would otherwise absorb every real
workout recorded while it ran. `contextClamped` is true when a session
claimed so long a span that only its first 48 hours of surrounding data were
read for the joined figures.

A rule that needs a second record type to tell an artefact by applies only
when the exposure policy lets that type be read: the cuff rule needs the
blood-pressure readings, the profile-weight rule the heights. A withheld type
is never read to apply a rule. The rule is then not applied, the figure is as
recorded, and the answer says so with a warning that names the rule and
nothing else: `resting_hr_cuff_rule_not_applied` (`daily_summary`'s
`restingHr` may include a cuff's pulse) or `weight_artefact_rule_not_applied`
(`daily_summary`'s `weight`, or an `hc_aggregate` of weight, may include a
profile entry). `daily_summary` counts what it left out per kind:
`hc_bp_duplicates_dropped:<n>`, `hc_other_origins_dropped:<n>` and
`resting_hr_cuff_pulse_excluded:<n>`.

`data_quality`'s `types` narrows which findings are reported, never what a
rule may read: asked about `Weight` alone it still tells a profile weight by
the height beside it, and asked about `ExerciseSession` alone it still reports
`likely_left_running`. Only the policy withholds context. Its `long_session`
finding is every exercise session over three hours; `source_switch` is
reported only when the app that supplied a type is absent, or nearly (at most
a tenth of the day's total, weighed by the field's sum and not by record
counts), on the day another takes over, so two apps recording side by side
are not a switch.

**Which mean.** Heart rate is sampled unevenly, every second during activity
and every few minutes at rest, so "the mean" depends on what is averaged:

| Field                                                      | What it is                                                                         |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `hr_series` `mean` at `1min`                               | The plain mean of that minute's samples.                                           |
| `hr_series` `mean` at `5min`, `1h`, or decimated           | The mean of the minute means in the bucket.                                        |
| `hr_series` `mean` at `5s`                                 | Time-weighted: each reading counts for as long as it stood.                        |
| `hr_series` `mean` at `raw`                                | The reading itself.                                                                |
| `sleep_sessions` `hr.mean`, `exercise_sessions` `hr.mean`  | The mean of per-minute means over the session; `min` and `max` are of the samples. |
| `hc_aggregate` `values.bpm.mean`                           | The plain mean of the samples of the records that start in the bucket.             |
| `daily_summary` `hrvRmssd`, `respiratoryRate`, `restingHr` | The plain mean of the day's records.                                               |

`hr_events` works on the minute means. An event's baseline is the 10th
percentile of the quiet minutes in the `window_s` seconds before it, with the
minutes of an earlier event left out. With the defaults (30 bpm over a
ten-minute window) a slow climb of a couple of beats a minute is **not**
reported, because the baseline climbs with it: lengthen `window_s` or lower
`min_delta_bpm` to look for one. `sleep_sessions`' `hrWake` is the first
sustained rise after the pulse was last settled, so an awakening the sleeper
went back to sleep from is not the wake; `stagesOverlap` says the wearable's
stages overlapped and were cut so that no stretch counts twice. An exercise
session's `steps`, `distance` and `energy` count a record that only partly
overlaps the session in proportion to the overlap.

**The exposure policy.** All four rule kinds apply to phone data. A
`health_system` rule on `device:<id>` removes that phone from every tool,
`hc_sync_status` and the summary included, and it is never queried; a
`resource` rule on `hc:<Type>` removes the type from every tool and from
`coverage`; a `field` rule removes one measurement, as described below.

A `tool` rule denies one of the eleven tools and nothing else. **It does not
hide that tool's data from the other ten:** with `sleep_sessions` denied, the
same nights are still in `hc_records`, `daily_summary` and the summary. To
withhold data, deny the type (`resource`) or the measurement (`field`); a
tool rule only removes one way of asking.

`hc_sync_status` reports two kinds of thing. Its per-type rows (and the
`records`, `phoneBacklog` and `typesWithData` on the phone's row) cover only the
types the policy lets the call see; a denied type has no row and is in no
count. The queue, rollup and upload figures on the phone's row (`backlog`,
`lastUploadAt`, `recentFailures`) are bookkeeping for the whole phone, are
not per type, and are shown whenever the phone is.

The error codes in `lastPhoneError` and `recentFailures` are pipeline health,
and nothing else. They are the stable codes the companion app and the server
use (`network`, `hc_rate_limited`, `backlogged`, `unsupported_media_type`,
`apply_gave_up`, ...), with one change made for MCP clients: what the phone
may read is not reported. An error that is only about one record type the
phone does not read is left out (`lastPhoneError` is null), because that is
by design and the type is simply absent from the data. When the phone is
reading nothing at all, the code is `phone_not_reading`, whatever the cause;
any code that words itself in those terms is replaced by it too. The Phone
page shows the true codes, and
[setup-android.md](setup-android.md) lists them.

A `resource` rule's type is checked when the rule is saved: it must be one of
the record types the companion app maps (all of them, including the ones with
nothing numeric to summarise, such as `hc:SexualActivity` or
`hc:MenstruationFlow`) or one a paired phone has reported, spelled exactly as
rows are tagged. `hc:sexualactivity` is refused with the right spelling, not
stored as a rule that matches nothing. A type nothing maps
(`Agg.<Something>` from a newer app) answers `unknown_type:hc:<Type>`, not a
policy warning.

**Field rules on phone data.** One measurement appears under several names:
a record's `data.systolic`, an aggregate's `values.systolic.mean`, a
session's `readings[].systolic`, a day's `bloodPressure.systolic`. A field
rule on a type names the measurement, not one spelling of it: written as any
of those (or as plain `systolic`), it removes all of them, in every tool the
rule's scope covers. That includes the places the measurement is joined onto
another type's row -- a rule on `hc:HeartRate` `bpm` removes a night's `hr`
and `hrWake`, a workout's `hr` and a reading's `pulse` -- and numbers derived
from it (`bmr_fill` is not applied, and says
`policy_field_removed:hc:BasalMetabolicRate.bmr`, when the rate is hidden). A
value computed from two types (`likelyLeftRunning`) is not reached by a field
rule on either; deny a type to remove it. One table of names
(`worker/src/policy/hc-aliases.ts`, over `JOINED_FIELDS` in
`worker/src/policy/hc-fields.ts`) drives this, and a test plants every
numeric field of every type and checks it is gone from every tool's answer.
A field rule that could remove nothing -- a field the type does not have, in
a tool that never carries that type -- is refused when it is saved, with the
reason and the names that would work.

Two things follow a type across rows of another type:

- A figure measured as one type but shown on another type's row belongs to
  the type it was measured as. A night's `hr` and `hrWake` are heart-rate
  data, its `skinTempDelta` is skin-temperature data, a reading's `pulse` is
  heart rate, a workout's `likelyLeftRunning` was read off heart rate and
  steps, a day's `weighings` are weight data. Denying `hc:HeartRate` removes those fields from `sleep_sessions`,
  `exercise_sessions`, `blood_pressure` and `daily_summary` as well, with a
  `policy_resource_denied:hc:HeartRate` warning. The field is removed, not
  recomputed and not nulled. One table (`JOINED_FIELDS` in
  `worker/src/policy/hc-fields.ts`) says which field comes from which type, and a
  test fails if a tool emits a field the table does not name.
- The platform totals are stored as `Agg.<Metric>` types (`Agg.Steps`).
  They are not policy objects of their own: `Agg.Steps` is step data, is
  denied whenever `hc:Steps` is, and its rows are tagged `hc:Steps`.

A single settings toggle, **MCP enabled**, is a kill switch: when it is off,
every tool call answers `mcp_disabled` immediately, without reading
anything. It does not revoke any grant — turning it back on resumes exactly
where it left off.

## Connecting a client (claude.ai)

1. In claude.ai: **Customize → Connectors → + → Add custom connector**. Give it a
   name and the server URL, `https://<your-host>/mcp` (no trailing slash).
   Click **Continue**.
2. The **Authentication** screen that follows auto-detects "Register
   automatically (DCR)" — leave the Advanced settings empty. Click **Add**,
   then **Connect**.
3. claude.ai registers itself as an OAuth client via Dynamic Client
   Registration (`POST /oauth/register`, which bypasses Access, like the
   rest of the MCP-facing surface) and then redirects your browser to the
   consent page at `/authorize`.
4. **The consent page requires both gates**, exactly like the rest of the
   admin surface: Cloudflare Access, then the password session. If you have
   not already signed into the admin UI in that browser, `/authorize`
   answers with the login form instead of the consent screen; sign in and
   it resumes automatically.
5. The consent screen shows the client's name, id, redirect URI and
   requested scope, and warns plainly that approving grants read access to
   appointments, conditions, medications, results and documents from every
   connected health system, subject to your exposure policy. **Approve**.
6. claude.ai is redirected back with an authorization code, exchanges it at
   `/oauth/token`, and can now call tools at `/mcp` with a bearer token —
   this is the same flow Claude Code or any other MCP client speaking
   OAuth 2.1 (PKCE required, no implicit flow) would use.

The one scope this server ever issues is `health:read`; a client asking for
anything else still only receives that one.

### From Claude Code

```sh
claude mcp add --transport http -s user healthy https://<your-host>/mcp
```

Then, inside a session, run `/mcp` and complete the same consent flow in the
browser tab it opens.

## Managing what is exposed: the policy deny-list

The model is **allow-all with a deny-list**. On a fresh database, every
tool answers with everything it can reach. Rules only ever remove; nothing
in this system can be used to grant _more_ than a tool would otherwise
return, except "show a withheld field", below.

Manage rules from the admin UI's **MCP → Exposure policy** section
(`/connectors` — it moved off `/mcp` because `/mcp` is the transport, not a
page). There are four kinds:

| Kind            | What it names                            | Effect                                                                                                            |
| --------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `tool`          | a tool name, e.g. `get_lab_results`      | That tool answers `policy_denied` and reads nothing at all.                                                       |
| `resource`      | a FHIR resource type, e.g. `Observation` | Every item of that type disappears from every tool, the raw projection, and the summary's counts and sections.    |
| `health_system` | a health system                          | That health system disappears everywhere, `list_health_systems` included, and is never even queried.              |
| `field`         | a scope and one or more field paths      | Each path is removed from every item the scope reaches — the normalised item and the raw FHIR resource behind it. |

Every rule has an on/off switch: a rule switched off is kept, listed, and
enforces nothing until it is switched back on.

### Field rules: the builder

A field rule is built, not typed:

1. **Scope.** Every tool, one tool, or one resource type — and, optionally,
   one health system. With one tool you can also narrow to that tool's items
   of one type (the summary carries several).
2. **Fields.** An expandable tree of the real structure of those answers: the
   normalised item and, separately, the raw FHIR resource (`raw: true`), with
   nested objects and arrays, a short description where one is known, and a
   search box that matches names and descriptions. Arrays are marked "list":
   a field picked under one is removed from _every_ element. Fields present in
   your own cached data carry a dot; fields your data has that the model does
   not know are added and marked "not modelled" (names only are read — never
   values). Tick as many fields as you like: they become one rule. A path the
   tree does not show can be typed under **Type a path instead**, with
   autocomplete from the tree.
3. **Preview.** Before saving, the draft runs — in one request — over the
   real answer of every tool its scope reaches. The preview lists only the
   tools it changes, each with its count ("get_appointments — 7 of 106 items
   change"), and shows the first item it changes in the chosen tool before
   and after — removed keys struck through — for the item and the raw FHIR.
   When it changes nothing anywhere, it says so and why (the field is not in
   your cached data, or the scope does not reach it) instead. The preview is
   the live check too: a draft that would be refused on save is refused here,
   with the reason. It is for your eyes only: the samples are read by the
   admin API behind Access and the password, are not audited or logged, and
   `get_document_text` is only previewed when a rule names it, on a made-up
   item, rather than spend a metered document request.

The rule list reads each rule as a sentence — "Hide participants → name in
get_appointments at all health systems" — grouped by what it applies to,
with the tools it changes, the switch, edit and delete.

### Field paths

A path names a key below the root of one answer item (or one raw resource),
one segment per level:

| Path                               | Meaning                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `location.address.lines`           | nested objects                                                            |
| `participants[].name`              | `[]`: the `name` of every element of `participants`                       |
| `code.coding[].display`            | a raw FHIR coding's display text, in every coding                         |
| `component[].referenceRange[].low` | arrays inside arrays: the low bound of every range of every component     |
| `value[x]`                         | `[x]`: every FHIR choice-type variant — `valueQuantity`, `valueString`, … |
| `components[]`                     | a path _ending_ in `[]` removes every element, leaving `"components": []` |

`participants.[].name` is the same path, and so is `participants.name`: a
named segment that meets an array steps into every element whether or not the
path says `[]`, so two missing brackets can never turn a rule into a silent
no-op. The builder stores the canonical spelling.

**One rule, both vocabularies.** The normalised items rename things (`value`
is the raw `valueQuantity`, `practitioners[].name` is the raw
`participant[].individual.display`, `address.lines` is `address.line`), and
many normalised fields are a raw element _rendered_ to text (a code's
`display`, a reference's `display`, a date picked out of a period). A rule in
either vocabulary is translated through those renames
(`worker/src/fhir/normalize/<type>.ts` `FIELD_ALIASES`, plus the same-name
renderings the field tree implies), so hiding a coding's raw `display` also
removes the normalised text made from it, and hiding a normalised
practitioner name also removes the raw display and the appointment view's
`practitioner`. Where a normalised value came from another, referenced
resource (a location's address on an Encounter), the raw resource holds only
the reference, and there is nothing to translate.

**Refused, with a reason.** A path that matches nothing in any shape the
rule's scope reaches — in either vocabulary — is refused with `400
bad_request` and a sentence saying where it stopped, what was there, and a
suggestion for a near miss (`there is no "nmae" under participants[] (there:
name, role). Did you mean "name"?`). So is a tool that does not exist, a
health system that does not exist, and a tool/resource-type pair that never
meet. Structure the model does not describe (extensions, for instance) is
accepted below that point, because it cannot be proven wrong.

**Redaction removes the key.** It never substitutes a marker: a placeholder
is something a model can mistake for data, and something a `jq` filter could
select. The answer's `warnings` say what went instead:
`policy_field_removed:<Type or *>.<path>`.

### Names inside references, and narratives

A FHIR resource names other resources in passing: every `Reference` carries a
`display`, the referenced resource's name, wherever it sits — `subject`,
`performer[]`, `resultsInterpreter[]`, `participant[].individual`, inside an
extension or a contained resource. No path rule could list them all, so the
policy judges each reference by the type it points at, taken from its
`reference` (`Practitioner/…`, an absolute URL, `#id` for a contained
resource) or its `type`. A reference's `display` and `identifier` are removed,
anywhere in the resource, when that type is:

- denied by a `resource` rule;
- `Patient` or `RelatedPerson`, when a hide rule reaches the patient's `name`
  (or the sensitive default withholds it);
- `Practitioner`, `PractitionerRole` or `Person`, when one of those is
  denied, a hide rule reaches its `name`, or a hide rule reaches a field a
  clinician's name is rendered into (`practitioners[].name`, the appointment
  view's `practitioner`, a `requester`, an `author`, `performers[].name`,
  `participants[].name` — in either vocabulary).

A reference whose type cannot be read (a bare `{ "display": … }`, a
`urn:uuid:`, a `#id` with no contained match) is removed whenever any person
type is restricted — it fails closed — and so is an annotation's
`authorString`. A coding's `display` (a code's text) is never touched. The
normalised strings rendered from these references (`practitioners[].name`,
`requester`, `author`, `payor`, …) go too, and so does what was read from a
withheld resource itself (a clinician's `specialty`, a denied Location's
address): judged by the raw reference they were read from, or — where no raw
resource is behind the item, as for a portal visit — by every type that field
may point at (for a portal visit's clinician, a practitioner). A
restriction applies at the health systems the triggering rule is scoped to,
in every resource type. A rule on a person's own `name` (`Patient.name`,
`Practitioner.name`) applies in every tool whatever its tool scope, since the
copy of that name in other tools' resources would otherwise be a way around
it; a rule on a field a name is rendered into keeps its tool scope. The
warning is
`policy_reference_display_removed:<TargetType>` (`unknown` for the untyped
kind), never the value.

`contained[]` resources are filtered as resources of their own type: a denied
type is dropped from the array, and every field rule for that type applies.

**Narratives.** A raw resource's `text` (the health system's HTML rendering of
the whole resource) cannot be filtered by path, so it is removed from any
resource that a field rule reaches, that has a sensitive field withheld, that
lost a reference display, or whenever any person type is restricted at all.
The warning is `policy_field_removed:<Type>.text`.

What no rule reaches is free prose: a report's `conclusion`, a note's text, a
document's decoded text (`get_document_text`). A name written into prose stays
there; hide the field or deny the tool if that matters.

### Show a withheld field

Some fields are withheld by default because the resource marks them
sensitive (currently `Patient.birthDate` and `Coverage.subscriberId`). A
field rule with the effect **show** (the builder's "Show a withheld field";
`effect: "allow"`) is the only way to put one back, and only such a field can
be named; it can be scoped like any other field rule. Everywhere a withheld
field is held back, the item's `sensitive` array is replaced with `withheld`,
so the model is told a field exists rather than left to assume it is empty.

### Order, and warnings

A tool deny short-circuits everything first; then health system and
resource-type denies drop whole items; then field rules; then the
sensitive-by-default stripping; then the caller's `jq`; then `limit`. Every
warning the policy produces is stable and free of values —
`policy_tool_denied:<tool>`, `policy_resource_denied:<Type>`,
`policy_health_system_denied` (deliberately without the id — the deny-list
itself is not for a third-party model to see, which is also why a field
rule's warning never names its tool or health system scope),
`policy_field_removed:<Type or *>.<path>`, `sensitive_withheld:<Type.field>`.

### The API

`GET /api/mcp/policy` lists the rules; `POST` adds one (`{ ruleType, target }`,
or for a field rule `{ ruleType: "field", field: { effect, tool, resourceType,
healthSystemId, paths } }` — a legacy `ResourceType.path` `target` is still
accepted and converted); `PATCH /api/mcp/policy/:id` switches, edits or
re-notes one; `DELETE` removes one. `GET /api/mcp/policy/schema` is the field
tree; `POST /api/mcp/policy/structure` (key names of one tool's real answer)
and `POST /api/mcp/policy/preview` (a draft's before and after) read real data
and so are POSTs behind the CSRF guard. Rules stored before migration 0012 as
one `ResourceType.path` string are converted by the migration.

## The audit log

Every tool call writes exactly one row to `mcp_audit`: the tool, the
calling client and grant id, which health system ids it touched, how many items
came back, whether it succeeded, and how long it took — never the content
of the answer. A call with a `jq` program also records the program's SHA-256
and length and how many items went into it and came out — not its text,
because a filter can name what the caller was looking for
(`select(.code | test("…"))`). View it in the admin UI's MCP page (`/connectors`), or `GET
/api/mcp/audit?limit=`. Rows older than 365 days are pruned automatically
(by the daily cron, and probabilistically on a small fraction of tool
calls, so an idle deployment does not accumulate them indefinitely either).

## Revoking a client

The admin UI's MCP page (`/connectors`) lists every linked client (name,
scope, when it was linked, last used) with a **Revoke** button, which deletes
its grant from the OAuth provider's store (Workers KV, not D1) via `DELETE
/api/mcp/grants/:id`. A revoked client's existing access token stops
working immediately; it has to complete the whole consent flow again,
including the two-factor consent page, to get another one.
