# Test fixtures

Everything under this directory is **synthetic**. It comes from Epic's public
FHIR sandbox (`https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4`) and
its published test patients (e.g. `fhircamila` / `epicepic1` -- see Epic's
"Sandbox Patients" documentation for the current list). There is no real
person, no real health system, and no real clinical data anywhere in this
directory.

**A response recorded from a real health system -- a real MyChart organisation, a
real patient, a real clinician -- must never be committed here, or anywhere
else in this repository.** See `CLAUDE.md` and `SECURITY.md` for the project's
full rule on personal data; this directory has no exception to it. If you are
ever holding a real FHIR response while working on this codebase, it belongs
in `.dev.vars`-adjacent local scratch space, not in `test/fixtures/`.

## What's here

- `epic/` -- small, hand-maintained fixtures for the unit and integration
  tests: individual Bundle pages, OperationOutcome bodies, a trimmed
  CapabilityStatement, and so on. These are edited directly; there is no
  script that regenerates them.
- `epic-sandbox/` -- the default output directory for `scripts/record-fixtures.ts`
  (below). Not created until you run it. If it exists, its `manifest.json`
  records what was recorded and when.

## Re-recording from the sandbox

`scripts/record-fixtures.ts` drives a real Epic sandbox OAuth flow and FHIR
session -- using the same `ProviderAdapter` and `FhirClient` code the Worker
runs in production, not a reimplementation of it -- and writes what comes back
as fixtures:

```sh
npm run record-fixtures -- --client-id <your sandbox nonprod client id>
```

This needs an Epic App Orchard sandbox app registration (free, self-service)
with `http://localhost:8787/oauth/callback` as a registered redirect URI. It
opens your browser to Epic's sandbox login; sign in as one of Epic's published
synthetic test patients. See the script's own `--help` for every option
(output directory, a client secret for a confidential app registration, the
per-Bundle-page entry cap, and a label recorded into `manifest.json`).

Every response is passed through `scripts/lib/scrub-fixture.ts` before it is
written: absolute URLs under the sandbox host are rewritten onto the same
placeholder host the hand-written fixtures under `epic/` already use, a few
fields that no normalizer or test in this repo reads (`meta.security`,
identity/photo extensions, `Patient.telecom`, everything in `Patient.address`
except city and state) are dropped, and large Bundles are truncated. The token
response is written with every token field replaced by the literal string
`"REDACTED"`. Read the header comments on both files before changing what gets
scrubbed -- the point is not that sandbox data is sensitive, but that fixtures
should stay small, stable, and free of anything that looks like it could be a
real record.

Re-run it whenever the shape of a fixture needs to change: it is easier to
record a fresh set than to hand-edit JSON to match a new registry entry or
normalizer.
