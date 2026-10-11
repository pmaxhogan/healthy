/**
 * Builds the title and Markdown body for the Trello card that says a phone's
 * uploads could not be applied.
 *
 * Pure formatting, like `reconnect.ts`: no fetch, no D1, no Env. `deviceName`
 * is user data -- the name the owner gave the phone -- and this module only
 * ever puts it into the returned strings; it never logs anything itself.
 *
 * What the card may say is deliberately little: that uploads are being kept
 * rather than lost, how many, the stable error code of the failure, and where
 * to look. Never anything from inside an upload -- no record type, no value,
 * no origin app -- and no id: the link is the Phone page's path and nothing
 * more. The occurrence time is UTC and labelled as such, for the reason given
 * in `reconnect.ts`.
 */

export interface BuildParkedCardInput {
  deviceName: string;
  /** The admin Phone page. A path on this app's own origin, with no id in it. */
  phoneUrl: string;
  /** Batches set aside when the alert was opened. */
  batches: number;
  /** Stable codes only (`apply_gave_up`, `crypto`, ...): this app's own vocabulary. */
  errorCodes: readonly string[];
  occurredAt: Date;
}

export interface ParkedCard {
  title: string;
  description: string;
}

const MAX_DESCRIPTION_LENGTH = 900;
/** Keeps an owner-chosen name from blowing the card budget on its own. */
const MAX_NAME_LENGTH = 80;
/** A code is short by construction; this bounds a list of them regardless. */
const MAX_CODES_LENGTH = 160;

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatOccurredAt(occurredAt: Date): string {
  return `${occurredAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function buildParkedCard(input: BuildParkedCardInput): ParkedCard {
  const name = clamp(input.deviceName, MAX_NAME_LENGTH);
  const title = `Uploads from ${name} are waiting in Healthy`;
  const count = input.batches === 1 ? "1 upload" : `${String(input.batches)} uploads`;
  const codes = clamp(input.errorCodes.join(", "), MAX_CODES_LENGTH);
  const because = codes === "" ? "" : ` (${codes})`;

  const why = `${count} from ${name} could not be applied${because} at ${formatOccurredAt(input.occurredAt)}. Nothing was lost: they are being kept until they can be applied.`;
  const steps = [
    `1. Open ${input.phoneUrl} (sign in with Cloudflare Access, then the Healthy password).`,
    `2. Find the phone, read what is set aside and why, and press "Retry" once the cause is fixed.`,
    `3. Done — this card completes itself when nothing from the phone is waiting any more.`,
  ].join("\n");

  return { title, description: clamp(`${why}\n\n${steps}`, MAX_DESCRIPTION_LENGTH) };
}
