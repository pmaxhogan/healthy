# The MCP server

Healthy exposes the aggregated record over the Model Context Protocol,
Streamable HTTP, at `/mcp`. It is OAuth-protected, every tool is read-only
(`readOnlyHint`), and every call passes through one server-side filter
before anything is serialised — see [SECURITY.md](../SECURITY.md) for why
that design exists. This page covers connecting a client, the consent flow,
the exposure policy's exact syntax, the audit log, and revoking access.

## Tools

The server registers (in `worker/mcp/tools/index.ts`): `get_health_summary`,
`list_health_systems`, `get_sync_status`, `get_patient_profile`,
`get_appointments`, `get_encounters`, `get_conditions`, `get_medications`,
`get_medication_fills`, `get_allergies`, `get_immunizations`,
`get_lab_results`, `get_vitals`, `get_social_history`, `get_procedures`,
`get_diagnostic_reports`, `get_documents`, `get_document_text`,
`get_care_team`, `get_care_plans`, `get_goals`, `get_devices`,
`get_coverage`, `get_service_requests`. Most accept an optional
`health_systems[]` filter and an optional `raw` flag that additionally returns
the underlying FHIR resource (filtered by the same policy as the normalised
one). The admin UI's MCP page (`/connectors`) lists the live catalogue.

Every answer is the same envelope:
`{ items, total, matched, warnings, truncated, generatedAt }` (plus `raw` when
asked for). `total` is how many items the exposure policy let through;
`matched` is the output count — how many values `jq` emitted (below), before
`limit`; equal to `total` without it. `truncated` is true only when a
caller-supplied `limit` cut something.

### Filtering server-side with `jq`

Every tool, `get_document_text` included, takes an optional `jq` argument: a
real jq program (jq 1.8.2) run on the server before the answer is returned,
so a model can ask for exactly the slice it needs instead of reading a whole
history. For example, on `get_lab_results`:

```json
{ "jq": ".[] | select(.effective >= \"2026-01-01\") | {code, value, effective}" }
```

- **Order.** Exposure policy, then `jq`, then `limit`. jq only ever sees what
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

**Engine.** jq-wasm (jq 1.8.2 built with Emscripten), vendored under
`worker/mcp/jq/vendor/` by `scripts/build-jq-wasm.mjs`, which adds fuel
metering and the memory ceiling with Binaryen. It was chosen over a jaq
(Rust) wasm build — no wasm32 toolchain on the build machine, and a
not-quite-jq dialect — and over pure-JavaScript interpreters, which cannot be
interrupted once a synchronous loop starts. Measured in Node 26 on synthetic
lab items: 1.04 MB wasm (361 KB gzipped); a fresh instance per call costs
~0.5–1 ms; a call takes ~1 ms on 4 KB of input, ~8 ms on 470 KB and
~40–60 ms on 2.3 MB; metering adds ~10–15%.

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
(`worker/fhir/normalize/<type>.ts` `FIELD_ALIASES`, plus the same-name
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
address): judged by the raw reference they were read from, or — for a portal
visit, or a summary item — by every type that field may point at. A
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
