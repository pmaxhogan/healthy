/**
Builds the title and Markdown body for the Trello card that says a sync
keeps failing.

Pure formatting, like `reconnect.ts`: no fetch, no D1, no Env.
`healthSystemName` is user data -- the display name of a connected health
system -- and this module only ever puts it into the returned strings; it
never logs anything itself.

This is the card for a failure that is *not* a re-auth, and that is the
whole reason it is its own formatter: the connection is still authorised, so
telling the owner to reconnect would send them through a consent screen that
changes nothing. What the card may say is what is failing, the stable code of
the failure, since when and how many runs, and where to look. Never a
message, a URL from a response or anything read from a record. The
occurrence time is UTC and labelled as such, for the reason given in
`reconnect.ts`.
*/

/**
Whose sync it is, which decides what the card calls it and what can be done.
`run` is the sync itself: a run that stops before it reaches any of the others.
*/
type SyncFailingKind = "health_system" | "portal" | "google" | "run";

/**
Which pass keeps failing. The same vocabulary as `sync_failures.check_name`:
`calendar` is the hourly appointment sync (or, for Google, reading and
writing the calendar itself), `refresh` the four-hourly read of the whole
record, `visits` a portal's visit list and `messages` its message centre.
*/
type SyncFailingCheck = "calendar" | "refresh" | "visits" | "messages";

export interface BuildSyncFailingCardInput {
  kind: SyncFailingKind;
  /** The health system's display name. Ignored for `google` and `run`. */
  healthSystemName: string;
  check: SyncFailingCheck;
  /** A stable code (`upstream_error`, `portal_parse_failed`, ...): this app's own vocabulary. */
  errorCode: string;
  /** Consecutive failed runs when the alert was opened. */
  failures: number;
  /** When the first of those runs failed. */
  failingSince: Date;
  /** The admin page that shows the current state. A path on this app's own origin, with no id in it. */
  pageUrl: string;
}

export interface SyncFailingCard {
  title: string;
  description: string;
}

const MAX_DESCRIPTION_LENGTH = 900;
/** Keeps an owner-chosen name from blowing the card budget on its own. */
const MAX_NAME_LENGTH = 80;
/** A code is short by construction; this bounds it regardless. */
const MAX_CODE_LENGTH = 80;

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatOccurredAt(occurredAt: Date): string {
  return `${occurredAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** What the card calls the thing that is not syncing. */
function subjectName(input: BuildSyncFailingCardInput): string {
  if (input.kind === "google") return "Google Calendar";
  const name = clamp(input.healthSystemName, MAX_NAME_LENGTH);
  return input.kind === "portal" ? `${name} patient portal` : name;
}

/** The pass that is failing, as the start of a sentence. */
function passName(input: BuildSyncFailingCardInput): string {
  if (input.kind === "google") return "Reading or writing the calendar";
  if (input.kind === "run") {
    return input.check === "refresh" ? "The refresh of the full record" : "The appointment sync";
  }
  switch (input.check) {
    case "refresh": {
      return "The refresh of the full record";
    }
    case "visits": {
      return "The sync of portal visits";
    }
    case "messages": {
      return "Reading portal messages";
    }
    default: {
      return "The appointment sync";
    }
  }
}

/**
The second step, which is the only one that differs.

A portal has one thing the owner can do that the others do not: its
scheduled sync holds back from signing in on its own (see `ensureSession` in
`portal-sync.ts`), and "Sign in now" is what ends that wait early.
*/
function adviceFor(input: BuildSyncFailingCardInput): string {
  if (input.kind === "run") {
    return `2. Nothing needs reconnecting: no connection was reached. The run list there shows each run that stopped. It is retried every hour; if this card is still open tomorrow, the error code above is where to start.`;
  }
  return input.kind === "portal"
    ? `2. Nothing needs re-entering. If the Patient portal card there says it is signed out or waiting, press "Sign in now"; otherwise leave it, it is retried every hour.`
    : `2. Nothing needs reconnecting: the connection is still authorised and the sync is retried every hour. If this card is still open tomorrow, the other side has changed and the error code above is where to start.`;
}

export function buildSyncFailingCard(input: BuildSyncFailingCardInput): SyncFailingCard {
  const code = clamp(input.errorCode, MAX_CODE_LENGTH);
  const runs = `${String(input.failures)} runs in a row`;
  const since = `since ${formatOccurredAt(input.failingSince)} (${code})`;

  let title: string;
  let why: string;
  if (input.kind === "run") {
    title = "Healthy's sync keeps stopping";
    why = `${passName(input)} has stopped before reaching any health system ${runs} ${since}.`;
  } else {
    const name = subjectName(input);
    title = `Healthy cannot sync ${name}`;
    why = `${passName(input)} for ${name} has failed ${runs} ${since}.`;
  }
  const steps = [
    `1. Open ${input.pageUrl} (sign in with Cloudflare Access, then the Healthy password) to see where it stands now.`,
    adviceFor(input),
    `3. Done — this card completes itself on the next run that works.`,
  ].join("\n");

  return { title, description: clamp(`${why}\n\n${steps}`, MAX_DESCRIPTION_LENGTH) };
}
