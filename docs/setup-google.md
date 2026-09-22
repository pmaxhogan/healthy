# Setting up Google Calendar

The sync writes appointments to one Google account's calendar, using an
OAuth client you create in your own Google Cloud project. This is a step
you complete once per deployment.

## 1. A Google Cloud project with the Calendar API enabled

Create a project (or reuse one), then enable the **Google Calendar API** for
it from the API Library.

## 2. The OAuth consent screen

Configure the consent screen as:

- **User type: External.** This app is not part of a Google Workspace
  organisation, so Internal is not an option; External works fine for an
  app only you will ever authorise.
- **Publishing status: Production**, not Testing.

### The 7-day refresh-token trap

This is the single most common way a deployment breaks silently. While a
consent screen is in **Testing** status, Google issues refresh tokens that
**expire after 7 days regardless of use** — the calendar sync would work
fine for a week and then start failing every subsequent request with
`invalid_grant`, opening a reconnect alert on a schedule that looks like a
bug. Moving the consent screen to **Production** removes that 7-day expiry
without requiring Google's app-verification review, because the scopes this
app requests are not in the tightly-restricted category. You do not need to
submit for verification for your own single-user deployment; leave it
unverified and published.

Every future consent grant will show an "unverified app" interstitial —
click through it (Advanced → proceed) each time you connect an account.
That is expected, not a misconfiguration. **(verify: exact wording changes
as Google updates the console.)**

### Scopes

Add exactly these two scopes and no others:

- `https://www.googleapis.com/auth/calendar.events.owned`
- `https://www.googleapis.com/auth/calendar.calendarlist.readonly`

`calendar.events.owned` is what makes the "never touch an event we did not
create" invariant possible at the API level: it grants read/write only on
events this app's own client created, not on the account's whole calendar.
`calendar.calendarlist.readonly` is only used to list calendars for the
picker and to resolve `primary` to a real calendar id; it grants no write
access.

## 3. The OAuth client

Under **Credentials**, create an **OAuth client ID** of type **Web
application**, and add both of these as authorised redirect URIs:

- `https://<your-host>/oauth/google/callback`
- `http://localhost:8787/oauth/google/callback`

Copy the client id and client secret into the `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` Worker secrets (see the README's secrets table).

## 4. Connect it

Test against a throwaway calendar before pointing this at your primary one:

1. Create a calendar named something like "Healthy test" in Google Calendar.
2. In the admin UI, open **Settings** → **Google**, click **Connect**, and
   sign in with the account whose calendar you want events written to.
   Approve both scopes on the consent screen — if either is missing, the
   token exchange fails outright, since a partial grant is refused rather
   than accepted silently.
3. Pick the throwaway calendar in the calendar picker, run a sync, and
   confirm events appear correctly formatted before switching the setting
   to your primary calendar.

If the Google connection ever needs re-authorising, the reconnect flow asks
for consent again with `prompt=consent`, which is what makes Google issue a
fresh refresh token on every reconnect rather than only on the very first
one.
