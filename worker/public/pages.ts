// The public surface: /health, /about, /privacy, /terms.
//
// These four bypass both gates, so they are the only pages an unauthenticated
// stranger can read -- which is exactly why they exist. /about, /privacy and
// /terms are the URLs an app-registration review reads before approving the
// project's API access, and the reviewer has no Access identity.
//
// They describe the SOFTWARE, never its operator. No name, no health system, no
// location, no contact address: the repository is public and the deployment is
// one person's medical record. "The operator" is the subject throughout, and the
// contact channel is the public issue tracker, which is already public.

import { Hono } from "hono";

import { htmlPage, htmlResponse } from "./html.ts";

import type { AppHonoEnv } from "../auth/gate.ts";
import type { HealthResponse } from "@shared/types.ts";

const REPO = "https://github.com/pmaxhogan/healthy";

/**
 * `private`, not `public`: the pages carry nothing personal and would be safe in a
 * shared cache, but each response also carries a per-response CSP nonce, and a
 * shared cache handing the same nonce to many readers is a nonce in name only.
 * A browser-local cache still spares a reviewer's repeat visits.
 */
const PUBLIC_CACHE = "private, max-age=3600";

function footer(): string {
  return `<footer>
<p>Healthy is free software under the MIT licence. Source, issues and licence
text: <a href="${REPO}">${REPO}</a>.</p>
<p><a href="/about">About</a> &middot; <a href="/privacy">Privacy</a> &middot; <a href="/terms">Terms</a></p>
</footer>`;
}

const ABOUT = `<main>
<h1>Healthy</h1>
<p>Healthy is a small, single-user, open-source tool. One person -- its operator --
runs their own copy, connects it to their own patient accounts, and it works only
for them. There is no hosted service, no sign-up, and no shared instance.</p>

<h2>What it does</h2>
<p>It does two things with one copy of the operator's own medical record:</p>
<ul>
<li><strong>Calendar sync.</strong> It reads the operator's own upcoming
appointments from their Epic MyChart patient portals, using Epic's patient-facing
SMART on FHIR API and the operator's explicit consent, and writes them to the
operator's own Google Calendar. Each event carries the visit type, the clinic, the
address and a link back to the portal, so the appointment is legible without
logging in anywhere. An appointment that disappears from the portal is marked
cancelled rather than deleted.</li>
<li><strong>A read-only MCP server.</strong> The same record is exposed over the
Model Context Protocol so the operator can ask an AI assistant questions about
their own health history. Every tool is read-only: nothing the assistant does can
write to a patient record, a portal, or a calendar. Access is OAuth-protected and
scoped to the operator, each call is logged, and a server-side policy can withhold
whole categories or individual fields before anything is serialised.</li>
</ul>

<h2>How it is built</h2>
<p>It is a single Cloudflare Worker: one TypeScript codebase, one small SQL
database, no other infrastructure. Epic is the only electronic-health-record
vendor supported today, behind an adapter interface so others can be added.
Connections are made through the vendor's published patient API with the
operator's own authorisation; the project is not affiliated with Epic Systems, or
with any health system, and speaks for neither.</p>

<h2>Licence and source</h2>
<p>MIT. The whole implementation, including everything described on this page, is
public at <a href="${REPO}">${REPO}</a>.</p>
</main>`;

const PRIVACY = `<main>
<h1>Privacy</h1>
<p>Healthy is single-user software that an operator runs for themselves. This page
describes what a deployment does with data. It is not a service privacy policy,
because there is no service: there is no account to create and nobody else's data
to handle.</p>

<h2>Whose data</h2>
<p>Only the operator's own. A deployment holds one person's health record,
retrieved from patient portals that the operator authorised, plus the calendar and
portal credentials needed to keep doing so. No third party's data is collected, and
the software has no way to read anyone else's record.</p>

<h2>Where it lives</h2>
<p>In the operator's own cloud account -- their own Worker, their own database.
Nothing is sent to the project's authors, and there is no shared backend that a
deployment reports to.</p>

<h2>How it is protected</h2>
<ul>
<li>Every stored credential, every access and refresh token, and every cached
clinical record is encrypted by the application before it is written, with a key
held only as a deployment secret.</li>
<li>The whole administrative interface sits behind two independent gates: a
single-sign-on identity check, and a password.</li>
<li>Assistant access goes through OAuth, is read-only, and is filtered by a
server-side policy before any data leaves the process.</li>
<li>Logs record counts, timings and error codes. They deliberately never record
clinical content, credentials or identifiers.</li>
</ul>

<h2>Who else sees it</h2>
<p>Nobody. There are no analytics, no trackers, no advertising, no third-party
scripts on any page, and no data sharing of any kind. The only outbound network
calls a deployment makes are to the services the operator connected it to.</p>

<h2>Retention and deletion</h2>
<p>Cached clinical data exists to answer the operator's own questions quickly and
is refreshed on a schedule. Usage logs for assistant access are kept for one year
and then pruned automatically. The operator can disconnect any connection at any
time, which revokes the stored tokens, and can delete the whole deployment and its
database -- after which nothing remains.</p>

<h2>Questions</h2>
<p>Open an issue at <a href="${REPO}/issues">${REPO}/issues</a>. Please do not put
personal or health information in a public issue.</p>
</main>`;

const TERMS = `<main>
<h1>Terms</h1>
<p>Healthy is personal, open-source software, published under the MIT licence.
These terms apply to the software itself. There is no hosted service to sign up
for, and running a copy creates no relationship with the project's authors.</p>

<h2>Licence</h2>
<p>MIT. You may use, copy, modify and redistribute the software subject to that
licence, whose full text ships with the source at
<a href="${REPO}">${REPO}</a>.</p>

<h2>No warranty</h2>
<p>The software is provided "as is", without warranty of any kind, express or
implied, including but not limited to the warranties of merchantability, fitness
for a particular purpose and non-infringement. In no event shall the authors or
copyright holders be liable for any claim, damages or other liability, whether in
an action of contract, tort or otherwise, arising from, out of or in connection
with the software or its use.</p>

<h2>Not medical advice</h2>
<p>Healthy copies and summarises information from patient portals. It may be
incomplete, out of date, or wrong -- a sync can fail, a portal can change, and a
calendar entry can be stale. It is not medical advice and must not be relied on
for clinical decisions. The patient portal and the treating clinician remain the
authoritative source for appointments and for every other part of a medical
record.</p>

<h2>Your responsibilities as an operator</h2>
<p>If you run a copy, you are responsible for the accounts you connect it to, for
the secrets you configure, for complying with the terms of the portals and
calendars you authorise it to reach, and for the security of your own cloud
account.</p>
</main>`;

/**
 * Mounted before the gates in app.ts, so a stranger reaches exactly these four
 * routes and nothing else.
 */
export const publicRouter = new Hono<AppHonoEnv>();

/**
 * Liveness probe. Deliberately says nothing but `ok`: no version, no build, no
 * connection count. It is the one endpoint reachable by anyone on the internet,
 * so anything it reports is information disclosure.
 */
publicRouter.get("/health", (c) =>
  c.json<HealthResponse>({ ok: true }, 200, { "cache-control": "no-store" }),
);

publicRouter.get("/about", (c) =>
  htmlResponse(
    htmlPage({ title: "About Healthy", nonce: c.get("nonce"), body: ABOUT + footer() }),
    200,
    {
      "cache-control": PUBLIC_CACHE,
    },
  ),
);

publicRouter.get("/privacy", (c) =>
  htmlResponse(
    htmlPage({ title: "Healthy privacy", nonce: c.get("nonce"), body: PRIVACY + footer() }),
    200,
    {
      "cache-control": PUBLIC_CACHE,
    },
  ),
);

publicRouter.get("/terms", (c) =>
  htmlResponse(
    htmlPage({ title: "Healthy terms", nonce: c.get("nonce"), body: TERMS + footer() }),
    200,
    {
      "cache-control": PUBLIC_CACHE,
    },
  ),
);
