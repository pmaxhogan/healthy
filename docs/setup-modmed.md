# Setting up ModMed

ModMed (Modernizing Medicine: EMA, gGastro) is the second health-system vendor,
through its **Certified FHIR API**. Like Epic it is two jobs: registering an
application with ModMed (once, for your whole deployment), and then connecting
individual practices to it from the admin UI.

ModMed's own documentation is the authority and the process changes over time —
this page is only the shape of it, as it stood when this was written.

This is not the same thing as the ModMed **patient portal** connection described
in the README. The certified API has no `Appointment` resource, so upcoming
visits still come from the portal; the FHIR connection is the clinical record
(conditions, medications, documents, encounters and so on). A practice can have
both.

## 1. Register the app in the vendor dashboard

Create an account in ModMed's FHIR vendor dashboard and register a new app:

- **App type: Patient.**
- **Client type: confidential**, with **PKCE (S256)**.
- **Redirect URL:** `https://<your worker host>/oauth/callback`. The form takes
  exactly one, so there is no second entry for `http://localhost:8787`. See
  [Local development](#local-development) below.
- **Scopes:** `openid`, `fhirUser`, `offline_access`, `launch/patient`, and
  every `patient/<Resource>.rs` scope the form offers. The Worker asks for all
  of them, and ModMed refuses the whole sign-in over a scope the app is not
  registered for — it does not quietly drop it, the way Epic does.

The app is reviewed by ModMed before it works; until then the dashboard shows it
as disabled. There is no sandbox and no test patient: the first sign-in is a
real one.

When it is enabled, set the client id as a Worker secret:

```sh
wrangler secret put MODMED_CLIENT_ID
```

The client secret is not a Worker secret. It is pasted into the health system in
the admin UI and stored encrypted in D1, exactly like an Epic organisation's.

## 2. Find the practice's own FHIR base

**Every practice has its own FHIR base URL, and that is the one to enter.**
ModMed publishes the list as a public FHIR `Endpoint` bundle, linked from its
"Accounts FHIR URL Endpoints" page; search it for the practice's name. The
practice's base usually starts with the same subdomain as its patient portal.

ModMed also runs a base that belongs to no practice. It answers discovery like
any other, so the admin UI will accept it — and then its sign-in page rejects
every patient's username and password, because it has no practice to look the
patient up in. If the sign-in says "Invalid username or password" for
credentials that work on the practice's portal, this is why.

## 3. Add the health system

In the admin UI, add a health system, choose **ModMed**, and enter the display
name, the practice's FHIR base and the client secret. Then press **Connect**
and sign in with the username and password you use on that practice's patient
portal ("Continue as Patient").

## What to expect

- **Access tokens last about five minutes.** The Worker refreshes ahead of
  that; the refresh token is long-lived and rotated on every use.
- **Nothing goes on the calendar from this connection.** A ModMed Encounter is
  the record of a visit that happened, timed from when it was opened in the
  chart rather than when it was booked, so the calendar is left to the patient
  portal connection. Encounters are still cached with the rest of the record.
- **Searches are not narrowed by category.** A plain patient search returns
  everything, including documents filed under categories of the practice's own.
- **Some types can fail on ModMed's side.** A search that answers with a server
  error is recorded as `failed` for that type and retried on the next refresh;
  the other types are unaffected.
- **Document bodies are not fetched.** ModMed serves attachments as short-lived
  signed links rather than FHIR `Binary` resources, which the document reader
  does not follow yet. Document metadata is cached like any other resource.

## Local development

Because only one redirect URL can be registered, a sign-in started from
`http://localhost:8787` is refused. Unit and integration tests cover the adapter
with synthetic fixtures; a real sign-in can only complete against the deployed
Worker.
