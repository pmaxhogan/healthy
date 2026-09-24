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
  side has no CSN — when their starts are within five minutes (the calendar
  sync's own dedupe rule). The answer then carries the FHIR item, with any
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
return, except the one `allow:` exception below.

Manage rules from the admin UI's **MCP → Exposure policy** section
(`/connectors` — it moved off `/mcp` because `/mcp` is the transport, not a
page), or via `POST /api/mcp/policy` and `DELETE /api/mcp/policy/:id`. Each
rule has a `ruleType` and a `target`:

| `ruleType`      | `target`                                 | Effect                                                                                                                                                                                                               |
| --------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool`          | a tool name, e.g. `get_lab_results`      | That tool answers `policy_denied` and reads nothing at all.                                                                                                                                                          |
| `resource`      | a FHIR resource type, e.g. `Observation` | Every item of that type disappears from every tool, the raw projection, and the cross-health system summary.                                                                                                         |
| `health_system` | a health system id                       | That health system disappears everywhere, `list_health_systems` included, and is never even queried.                                                                                                                 |
| `field`         | a dotted path, see below                 | The named field is deep-deleted from the normalised item and the raw FHIR resource behind it; the path may be written in either vocabulary, and a path that names nothing in both is refused with `400 bad_request`. |

**Field paths** are `ResourceType.path.to.field`, or `*.path.to.field` to
apply to every resource type. For `Encounter` there are three vocabularies:
the raw FHIR resource, the normalized Encounter (`get_encounters`), and the
flat appointment view (`get_appointments`, `get_health_summary`) with its own
names — `practitioner`, `specialty`, `org`, `csn`, `encounterId`, `source`,
`firstParty`, `via`. A
rule naming a field in any of them removes every name that field has in the
others: `Encounter.practitioner`, `Encounter.practitioners` and
`Encounter.participant` all remove the practitioner from both tools and from
the raw resource. A path segment of `[]` — on its own, or as a
suffix on the segment before it (`components[]` and `components.[]` mean
the same thing) — steps into every element of an array, so
`Observation.component[].valueQuantity.value` removes that one value from
every component of every Observation.

**The one rule that adds rather than removes** is a `field` rule whose
target starts with `allow:` and names exactly two segments —
`allow:Patient.birthDate` or `allow:*.subscriberId`. Some fields are
withheld by default because the resource itself marks them sensitive
(currently `Patient.birthDate` and `Coverage.subscriberId`); an `allow:`
rule is the only way to put one back. Everywhere a `sensitive`-marked field
is withheld, the item's `sensitive` array is replaced with a `withheld`
array in the response, so the model is told a field exists and was held
back rather than left to assume the record is simply empty.

Rules are evaluated in a fixed order: a tool deny short-circuits everything
first; then health system and resource-type denies drop whole items; then field
rules; then the sensitive-by-default stripping. Every warning the policy
produces is stable and free of values — `policy_tool_denied:<tool>`,
`policy_resource_denied:<Type>`, `policy_health_system_denied` (deliberately
without the id — the deny-list itself is not for a third-party model to
see), `policy_field_removed:<target>`, `sensitive_withheld:<Type.field>`.

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
