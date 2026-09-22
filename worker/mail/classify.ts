/**
 * Turns a parsed inbound message into a `mail_inbox` kind, and pulls out
 * whatever that kind carries.
 *
 * Deliberately does not re-check the sender allowlist: `handler.ts` gates on
 * that before a message reaches here at all (`setReject`, no `mail_inbox`
 * row), so every message this module sees has already been accepted. What is
 * left to decide is purely a content question -- does this specific message
 * look like a login code, or is it Gmail's own, and only, forwarding
 * verification email, or neither.
 *
 * Kept free of Worker runtime types (like `worker/db/schemas.ts`), so the
 * unit tests can import it directly and `db/schemas.ts` can pull the default
 * allowlist from here without pulling in postal-mime or any Workers global.
 */

import type { MailKind } from "../db/rows.ts";

/** The exact sender of Gmail's own "confirm this forwarding address" email. */
export const GMAIL_FORWARD_VERIFY_SENDER = "forwarding-noreply@google.com";

/**
 * The allowlist this repository ships with, before the owner edits it from
 * the admin UI's Mail settings page.
 *
 * Deliberately generic: `"mychart."` matches any sender domain that contains
 * it -- whatever hostname a given Epic organisation's own MyChart instance
 * happens to send from -- so no specific health system's domain has to be
 * written down here (see CLAUDE.md's privacy rule). `"google.com"` is for
 * Gmail's forwarding-verification email. The owner adds their own tenant's
 * exact sending domain once they see real mail arrive.
 */
export const DEFAULT_MAIL_SENDER_ALLOWLIST = ["mychart.", "google.com"] as const;

export const DEFAULT_MAIL_SENDER_ALLOWLIST_CSV = DEFAULT_MAIL_SENDER_ALLOWLIST.join(",");

/** Split, trim, lower-case and drop blanks. The inverse of `formatAllowlistCsv`. */
export function parseAllowlistCsv(csv: string): string[] {
  return csv
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** Render a list of entries back to the comma-separated form the setting stores. */
export function formatAllowlistCsv(entries: readonly string[]): string {
  return parseAllowlistCsv(entries.join(",")).join(",");
}

/** The domain half of an email address, lower-cased. Empty string if there is no '@'. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1
    ? ""
    : address
        .slice(at + 1)
        .trim()
        .toLowerCase();
}

/**
 * Whether `from`'s domain is on the allowlist.
 *
 * Substring containment, not exact match: an entry like `"mychart."` matches
 * any domain that contains it, and a full domain the owner pastes in matches
 * exactly (a domain always contains itself). That is what lets one generic
 * default entry stand in for every Epic organisation's own MyChart hostname
 * without naming one.
 */
export function isAllowedSender(from: string, allowlist: readonly string[]): boolean {
  const domain = domainOf(from);
  return domain !== "" && allowlist.some((entry) => domain.includes(entry));
}

export interface Classification {
  kind: MailKind;
  /** The extracted digits for 'otp' or 'forward_verify'. Always null for 'other'. */
  code: string | null;
  /** The confirmation link. Only ever set for 'forward_verify'. */
  url: string | null;
}

const OTP_HINT = /\b(?:code|passcode|one-time|verification|security code)\b/i;
const OTP_DIGITS = /\b\d{4,8}\b/g;
/**
 * Gmail's own confirmation code is longer than a typical portal OTP; the
 * exact length was not independently re-verified this session (see
 * .local/planb-research.md §1-2), so this is deliberately a wider net than
 * the OTP pattern rather than a single fixed length.
 */
const FORWARD_VERIFY_DIGITS = /\b\d{6,12}\b/g;
const NEAR_WORDS = /\b(?:code|confirmation)\b/gi;
const URL_PATTERN = /https?:\/\/[^\s<>"')]+/i;
/** The only host a `forward_verify` link may point at: Gmail's own confirmation link. */
const GOOGLE_URL_HOST_SUFFIX = ".google.com";

interface Candidate {
  value: string;
  index: number;
}

/**
 * The digit run closest to the word "code"/"confirmation", or the first one
 * found when neither word appears anywhere in the text. Returns null when
 * `digits` matches nothing at all.
 */
function extractCodeNear(text: string, digits: RegExp, nearWords: RegExp): string | null {
  // eslint-disable-next-line unicorn/prefer-iterator-to-array -- Iterator#toArray() needs a lib newer than the ES2022 one this Worker compiles against (see the `Array#toSorted` note in `worker/policy/filter.ts`).
  const candidates: Candidate[] = [...text.matchAll(digits)].map((match) => ({
    value: match[0],
    index: match.index,
  }));
  const first = candidates[0];
  if (first === undefined) return null;

  // eslint-disable-next-line unicorn/prefer-iterator-to-array -- see above.
  const anchors = [...text.matchAll(nearWords)].map((match) => match.index);
  if (anchors.length === 0) return first.value;

  let best = first;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    for (const anchor of anchors) {
      const distance = Math.abs(candidate.index - anchor);
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      best = candidate;
    }
  }
  return best.value;
}

/**
 * Whether `candidate` is safe to hand to the admin UI as a clickable link.
 *
 * The extracted text is untrusted -- it came out of an email body -- so this
 * is not merely a sanity check on the regex above. `URL_PATTERN` only
 * requires an `http(s)://` prefix, which is not enough on its own: a message
 * could embed `https://attacker.example/…` right next to the real
 * confirmation code, and without this check that link would be sealed,
 * returned by the API, and rendered as a real `<a href>` in `MailView.vue`.
 * Restricting both the scheme (`https:` only, blocking `javascript:`,
 * `data:` and everything else) and the host (Google's own domain, since this
 * is only ever Gmail's forwarding-confirmation link) means a spoofed link
 * never survives classification, regardless of what the SPA does with it.
 */
function isSafeForwardVerifyUrl(candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    (url.hostname === "google.com" || url.hostname.endsWith(GOOGLE_URL_HOST_SUFFIX))
  );
}

function extractUrl(text: string): string | null {
  const candidate = URL_PATTERN.exec(text)?.[0] ?? null;
  return candidate !== null && isSafeForwardVerifyUrl(candidate) ? candidate : null;
}

/**
 * Classify one already-allowlisted message.
 *
 * `forward_verify` is decided purely by sender identity (there is exactly one
 * sender this can ever be); `otp` requires both a recognisable hint word and
 * an actual digit run nearby, so an allowlisted message that merely mentions
 * "code" in passing without a number does not get treated as a login code.
 */
export function classify(mail: { from: string; subject: string; text: string }): Classification {
  const from = mail.from.trim().toLowerCase();
  const combined = `${mail.subject}\n${mail.text}`;

  if (from === GMAIL_FORWARD_VERIFY_SENDER) {
    return {
      kind: "forward_verify",
      code: extractCodeNear(combined, FORWARD_VERIFY_DIGITS, NEAR_WORDS),
      url: extractUrl(combined),
    };
  }

  if (OTP_HINT.test(combined)) {
    const code = extractCodeNear(combined, OTP_DIGITS, NEAR_WORDS);
    if (code !== null) return { kind: "otp", code, url: null };
  }

  return { kind: "other", code: null, url: null };
}
