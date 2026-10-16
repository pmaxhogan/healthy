/**
Builds the title and Markdown body for a Trello reconnect card.

Pure formatting: no fetch, no D1, no Env. `healthSystemName` is user data --
the display name of a connected health system or "Google" -- and this
module only ever puts it into the returned strings; it never logs
anything itself.

There is no timezone here on purpose. This module owns no settings access
(see the "pure module" note above), and the rest of the codebase never
lets a timestamp imply the owner's local timezone (see CLAUDE.md); the
occurrence time is rendered in UTC and labeled as such instead.
*/

/**
One kind per fix, because the steps are the card.

`portal` is a portal the owner has to give something to again (the password,
or their confirmation of a new address). `portal_signin` is a portal whose
sign-in failed for a reason the stored password has nothing to do with -- the
emailed code never arrived, the portal was unreachable, a page stopped
parsing -- where the scheduled sync has stopped trying and pressing "Sign in
now" is the whole fix. Telling that owner to re-enter a password would be
telling them to fix the one thing that is not broken.
*/
type ReconnectKind = "epic" | "google" | "portal" | "portal_signin";

export interface BuildReconnectCardInput {
  kind: ReconnectKind;
  healthSystemName: string;
  reconnectUrl: string;
  reason?: string;
  occurredAt: Date;
}

export interface ReconnectCard {
  title: string;
  description: string;
}

const MAX_DESCRIPTION_LENGTH = 900;
/** Keeps a caller-supplied reason from blowing the overall card budget on its own. */
const MAX_REASON_LENGTH = 160;
const EPIC_CONSENT_NOTE =
  "\n\nIf the portal shows a consent screen, keep all data categories selected so the sync sees the whole record.";
/**
The word the card adds to a portal subject's name.

"Reconnect <name> patient portal to Healthy" rather than "Reconnect <name>
to Healthy", because the owner will eventually have a card of each kind for
the same health system and they are fixed in completely different places --
one is an OAuth consent screen, the other the portal login. Vendor-neutral:
the portal may be MyChart or ModMed.
*/
const PORTAL_LABEL = "patient portal";

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatOccurredAt(occurredAt: Date): string {
  return `${occurredAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function portalNoun(kind: ReconnectKind): string {
  return kind === "google" ? "Google" : "the patient portal";
}

/** What the card calls the thing that needs reconnecting. */
function subjectName(input: BuildReconnectCardInput): string {
  return input.kind === "portal" || input.kind === "portal_signin"
    ? `${input.healthSystemName} ${PORTAL_LABEL}`
    : input.healthSystemName;
}

/**
The steps, which differ by kind because the fix does.

A portal session is not an OAuth grant: there is no consent screen and no
redirect, only the owner's own password and the code the portal emails. Telling
them to "click Reconnect" would send them looking for a button that is not
there.
*/
function stepsFor(input: BuildReconnectCardInput): string {
  const open = `1. Open ${input.reconnectUrl} (sign in with Cloudflare Access, then the Healthy password).`;
  if (input.kind === "portal_signin") {
    return [
      open,
      `2. In the Patient portal card, press "Sign in now". The password on file is kept and nothing needs re-entering; if the portal emails a code, leave it to pick that up. Healthy has stopped signing in on its own until you do.`,
      `3. Done — this card completes itself when the sync sees the portal again. If the sign-in fails again with the same code, the portal itself is the problem: try again later.`,
    ].join("\n");
  }
  const settles = `3. Done — this card completes itself when the sync sees the new connection.`;
  if (input.kind === "portal") {
    return [
      open,
      `2. In the Patient portal card, re-enter the portal password and save it (confirming any new address it shows), then press "Sign in now"; if the portal emails a code, leave it to pick that up.`,
      settles,
    ].join("\n");
  }
  return [
    open,
    `2. Click "Reconnect" and sign in to ${portalNoun(input.kind)} when redirected.`,
    settles,
  ].join("\n");
}

export function buildReconnectCard(input: BuildReconnectCardInput): ReconnectCard {
  const name = subjectName(input);
  const title =
    input.kind === "portal_signin"
      ? `Sign in to ${name} again in Healthy`
      : `Reconnect ${name} to Healthy`;
  const when = formatOccurredAt(input.occurredAt);
  const reason = input.reason === undefined ? undefined : clamp(input.reason, MAX_REASON_LENGTH);

  const why =
    reason === undefined
      ? `The connection to ${name} stopped working at ${when}.`
      : `The connection to ${name} stopped working (${reason}) at ${when}.`;

  const consentNote = input.kind === "epic" ? EPIC_CONSENT_NOTE : "";

  const description = clamp(`${why}\n\n${stepsFor(input)}${consentNote}`, MAX_DESCRIPTION_LENGTH);

  return { title, description };
}
