/**
 * Builds the title and Markdown body for a Trello reconnect card.
 *
 * Pure formatting: no fetch, no D1, no Env. `healthSystemName` is user data --
 * the display name of a connected health system or "Google" -- and this
 * module only ever puts it into the returned strings; it never logs
 * anything itself.
 *
 * There is no timezone here on purpose. This module owns no settings access
 * (see the "pure module" note above), and the rest of the codebase never
 * lets a timestamp imply the owner's local timezone (see CLAUDE.md); the
 * occurrence time is rendered in UTC and labeled as such instead.
 */

type ReconnectKind = "epic" | "google" | "portal";

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
  "\n\nIf the portal shows a consent screen, keep all data categories selected so the sync sees appointments.";
/**
 * The word the card adds to a portal subject's name.
 *
 * "Reconnect <name> MyChart to Healthy" rather than "Reconnect <name> to
 * Healthy", because the owner will eventually have a card of each kind for the
 * same health system and they are fixed in completely different places -- one is
 * an OAuth consent screen, the other a password and an emailed code.
 */
const PORTAL_LABEL = "MyChart";

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
  return input.kind === "portal"
    ? `${input.healthSystemName} ${PORTAL_LABEL}`
    : input.healthSystemName;
}

/**
 * The steps, which differ by kind because the fix does.
 *
 * A portal session is not an OAuth grant: there is no consent screen and no
 * redirect, only the owner's own password and the code the portal emails. Telling
 * them to "click Reconnect" would send them looking for a button that is not
 * there.
 */
function stepsFor(input: BuildReconnectCardInput): string {
  const open = `1. Open ${input.reconnectUrl} (sign in with Cloudflare Access, then the Healthy password).`;
  const settles = `3. Done — this card completes itself when the sync sees the new connection.`;
  if (input.kind === "portal") {
    return [
      open,
      `2. In the MyChart portal card, re-enter the portal password, save it, then press "Sign in now" and leave it to pick up the emailed code.`,
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
  const title = `Reconnect ${name} to Healthy`;
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
