# The MCP server

Healthy exposes the aggregated record over the Model Context Protocol,
Streamable HTTP, at `/mcp`. It is OAuth-protected, every tool is read-only
(`readOnlyHint`), and every call passes through one server-side filter
before anything is serialised — see [SECURITY.md](../SECURITY.md) for why
that design exists. This page covers connecting a client, the consent flow,
the exposure policy's exact syntax, the audit log, and revoking access.

## Tools

The server registers (in `worker/mcp/tools/index.ts`): `get_health_summary`,
`list_providers`, `get_sync_status`, `get_patient_profile`,
`get_appointments`, `get_encounters`, `get_conditions`, `get_medications`,
`get_medication_fills`, `get_allergies`, `get_immunizations`,
`get_lab_results`, `get_vitals`, `get_social_history`, `get_procedures`,
`get_diagnostic_reports`, `get_documents`, `get_document_text`,
`get_care_team`, `get_care_plans`, `get_goals`, `get_devices`,
`get_coverage`, `get_service_requests`. Most accept an optional
`providers[]` filter and an optional `raw` flag that additionally returns
the underlying FHIR resource (filtered by the same policy as the normalised
one). The admin UI's MCP page (`/connectors`) lists the live catalogue.

A single settings toggle, **MCP enabled**, is a kill switch: when it is off,
every tool call answers `mcp_disabled` immediately, without reading
anything. It does not revoke any grant — turning it back on resumes exactly
where it left off.

## Connecting a client (claude.ai)

1. In claude.ai: **Settings → Connectors → Add custom connector**. Give it a
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

| `ruleType` | `target`                                 | Effect                                                                                                  |
| ---------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `tool`     | a tool name, e.g. `get_lab_results`      | That tool answers `policy_denied` and reads nothing at all.                                             |
| `resource` | a FHIR resource type, e.g. `Observation` | Every item of that type disappears from every tool, the raw projection, and the cross-provider summary. |
| `provider` | a provider id                            | That provider disappears everywhere, `list_providers` included, and is never even queried.              |
| `field`    | a dotted path, see below                 | The named field is deep-deleted from the normalised item and the raw FHIR resource behind it.           |

**Field paths** are `ResourceType.path.to.field`, or `*.path.to.field` to
apply to every resource type. A path segment of `[]` — on its own, or as a
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
first; then provider and resource-type denies drop whole items; then field
rules; then the sensitive-by-default stripping. Every warning the policy
produces is stable and free of values — `policy_tool_denied:<tool>`,
`policy_resource_denied:<Type>`, `policy_provider_denied` (deliberately
without the id — the deny-list itself is not for a third-party model to
see), `policy_field_removed:<target>`, `sensitive_withheld:<Type.field>`.

## The audit log

Every tool call writes exactly one row to `mcp_audit`: the tool, the
calling client and grant id, which provider ids it touched, how many items
came back, whether it succeeded, and how long it took — never the content
of the answer. View it in the admin UI's MCP page (`/connectors`), or `GET
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
