# Setting up Epic

Epic is the only health-system vendor implemented today. Connecting one is
two separate jobs: registering an application on Epic's developer portal
(once, for your whole deployment), and then connecting individual health
systems to it from the admin UI (once per organisation you get care from).

Epic's own documentation is the authority here and the process changes over
time — this page is only the shape of it, as it stood when this was written.
Steps marked **(verify)** are worth re-checking against
[fhir.epic.com](https://fhir.epic.com) before you rely on them.

## 1. Register the app on fhir.epic.com

Create a developer account and start a new app record with:

- **Audience: Patients.** This is a patient-facing app reading one person's
  own record, not a backend service.
- **Client type: confidential** (a client secret, not a public client).
  Refresh tokens require a confidential client — without one, every
  connection would need re-authorising hourly instead of automatically
  refreshing.
- **FHIR version: R4 only.** Skip the DSTU2/STU3 options.
- **SMART on FHIR version: v2** (scopes of the form `patient/Encounter.rs`
  rather than v1's `patient/Encounter.read`).

### Choose USCDI v3 auto-download, and understand why Appointment is missing

Epic can auto-generate the read scopes for an app from its published
**USCDI v3** resource-type appendix, rather than you picking them by hand.
Take that option. It gives you `.Read` and `.Search` for every USCDI
resource type this app can plausibly use — Patient, Encounter, Condition,
Observation, MedicationRequest, AllergyIntolerance, Immunization, Procedure,
DiagnosticReport, DocumentReference, CarePlan, CareTeam, Goal, Device,
Coverage, ServiceRequest, Specimen, and the US Core support resources
(Location, Practitioner, Organization, PractitionerRole).

**`Appointment` is deliberately absent, on purpose, and you should not add
it by hand.** `Appointment` is not part of USCDI. Epic offers **Automatic
Client ID Distribution**: once your app is approved, it is silently
provisioned against every organisation that allows auto-download, with no
health-system administrator having to review it individually. Registering
even one non-USCDI API — `Appointment` included — disqualifies an app from
that program and forces the slow path instead, where each organisation has
to manually approve the app before it can be used there. Upcoming
appointments are read from `Encounter` resources with `status=planned`
instead — a workable substitute, though a lossier one than a true
`Appointment` search; see
[docs/operations.md](operations.md) for what that means in practice.

### Fill in the rest

- **Data Use Questionnaire (DUQ).** Answer it honestly: data is stored on
  your own infrastructure, is not shared with or sold to anyone, and is used
  only to serve the one patient who authorised it. **(verify)** whether this
  is still a required step and where it lives in the current UI.
- **Public documentation, privacy and terms URLs.** Point these at your own
  deployment's `/about`, `/privacy` and `/terms` — the Worker serves all
  three without authentication for exactly this purpose.
- **Redirect URIs.** Register both:
  - `https://<your-host>/oauth/callback`
  - `http://localhost:8787/oauth/callback`

### Sandbox, then production — and the immutability trap

Save the app record and mark it **Ready for Sandbox**. Test against Epic's
published sandbox patients first (§6 below).

When you are satisfied, mark it **Ready for Production**. **(verify)** As of
this writing, an app record becomes immutable once it reaches this state —
its registered API list cannot be edited afterward. Adding a resource type
you forgot means creating an entirely new app record with new client IDs,
not amending this one. Get the scope list right before taking this step;
the USCDI v3 auto-download option in the previous section is what makes
that easy to get right the first time.

The app record carries two client ids: a **Non-Production** id (used
against the sandbox and every organisation's non-production environment)
and a **Production** id. These map directly to the `EPIC_CLIENT_ID_NONPROD`
and `EPIC_CLIENT_ID_PROD` secrets.

### Per-organisation client secrets

Marking an app Ready for Production does not, by itself, let it talk to any
real organisation. **(verify)** Each health system you connect to must
individually provision a client secret for your app — typically from a
"manage downloads" or similar screen in the developer portal, per
organisation and per environment (production vs. non-production). Request a
secret only for the organisation(s) you actually intend to connect; nothing
else needs enabling.

Propagation is not instant: expect on the order of an hour for a sandbox
change to take effect, and considerably longer — up to roughly two days —
for a newly Ready-for-Production app to appear at a given organisation once
its secret has been provisioned. **(verify exact timing; it varies and Epic
does not commit to a number.)** If authorisation fails immediately after
completing these steps, wait and retry before assuming something is
misconfigured.

## 2. Add a provider in the admin UI

Once the app is registered (sandbox is enough to start):

1. Open the admin UI → **Providers** → **Add provider**.
2. Either pick your health system from the searchable list — sourced from
   `data/epic-brands.json`, a slimmed copy of Epic's own published directory
   of FHIR endpoints — or enter a FHIR base URL manually. A manual URL is
   verified with a live SMART discovery request before the provider is
   saved; an endpoint that is not really an Epic FHIR server is rejected at
   that point rather than silently stored.
3. Choose the **environment**: `sandbox` while testing, `prod` for a real
   organisation.
4. Save, then open the provider and set its **client secret** — the one
   provisioned for your app at that organisation in the previous section.
   This is write-only: once saved, the admin UI never displays it again.
5. Click **Connect**. You are redirected through `/oauth/epic/start`, land
   on that organisation's own sign-in and consent screen, and are returned
   to `/oauth/callback`. Approve every data category the consent screen
   offers — narrowing it there can silently exclude appointments from the
   sync.
6. Use **Sync now** to test the appointment sync immediately, and **Full
   refresh** to populate the data the MCP server reads from, rather than
   waiting for the next scheduled run.

If a connection later stops working, a Trello card appears with a one-click
reconnect link — see [docs/operations.md](operations.md) for what that
means and how it resolves itself.
