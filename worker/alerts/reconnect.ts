/**
 * Builds the title and Markdown body for a Trello reconnect card.
 *
 * Pure formatting: no fetch, no D1, no Env. `providerName` is user data --
 * the display name of a connected health system or "Google" -- and this
 * module only ever puts it into the returned strings; it never logs
 * anything itself.
 *
 * There is no timezone here on purpose. This module owns no settings access
 * (see the "pure module" note above), and the rest of the codebase never
 * lets a timestamp imply the owner's local timezone (see CLAUDE.md); the
 * occurrence time is rendered in UTC and labeled as such instead.
 */

export type ReconnectKind = "epic" | "google";

export interface BuildReconnectCardInput {
  kind: ReconnectKind;
  providerName: string;
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

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatOccurredAt(occurredAt: Date): string {
  return `${occurredAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function portalNoun(kind: ReconnectKind): string {
  return kind === "google" ? "Google" : "the patient portal";
}

export function buildReconnectCard(input: BuildReconnectCardInput): ReconnectCard {
  const title = `Reconnect ${input.providerName} to Healthy`;
  const when = formatOccurredAt(input.occurredAt);
  const reason = input.reason === undefined ? undefined : clamp(input.reason, MAX_REASON_LENGTH);

  const why =
    reason === undefined
      ? `The connection to ${input.providerName} stopped working at ${when}.`
      : `The connection to ${input.providerName} stopped working (${reason}) at ${when}.`;

  const steps = [
    `1. Open ${input.reconnectUrl} (sign in with Cloudflare Access, then the Healthy password).`,
    `2. Click "Reconnect" and sign in to ${portalNoun(input.kind)} when redirected.`,
    `3. Done — this card completes itself when the sync sees the new connection.`,
  ].join("\n");

  const consentNote = input.kind === "epic" ? EPIC_CONSENT_NOTE : "";

  const description = clamp(`${why}\n\n${steps}${consentNote}`, MAX_DESCRIPTION_LENGTH);

  return { title, description };
}
