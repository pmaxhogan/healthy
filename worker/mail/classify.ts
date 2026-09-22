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
  /**
   * Which keyword matched to produce an 'otp' classification (e.g.
   * `"verification token"`, `"code is"`). Always null for 'forward_verify'
   * and 'other'. Never the code itself -- this is what `handler.ts` logs as
   * `otp_match` so a misclassification can be diagnosed from the logs
   * without ever writing a code or message content to them.
   */
  reason: string | null;
}

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

/**
 * Strong OTP keywords, checked in priority order so that a message matching
 * several of them (a real MyPortal-style message matches both "verification
 * token" and "token is") reports the most specific one as `reason`. Each
 * entry's `pattern` must carry the `g` flag: it is used with `matchAll` both
 * to test presence and to collect every occurrence as an anchor for
 * `pickNearestCandidate`.
 *
 * Deliberately excludes "confirmation": that word is `forward_verify`'s own
 * anchor (Gmail's email), and folding it in here would make an allowlisted
 * appointment-confirmation email with an unrelated number in it look like a
 * login code.
 */
const OTP_KEYWORDS: readonly { reason: string; pattern: RegExp }[] = [
  { reason: "verification token", pattern: /verification\s+token/gi },
  { reason: "security token", pattern: /security\s+token/gi },
  { reason: "passcode", pattern: /passcode/gi },
  { reason: "one-time", pattern: /one[- ]time/gi },
  { reason: "OTP", pattern: /\botp\b/gi },
  { reason: "token is", pattern: /\btoken\s+is\b/gi },
  { reason: "code is", pattern: /\bcode\s+is\b/gi },
  { reason: "code", pattern: /\bcode\b/gi },
];

/**
 * "verification" alone is a weak hint: plenty of ordinary mail ("complete
 * your email verification") uses the word without being a login code, so it
 * only counts when an actual digit run sits within
 * `NEAR_VERIFICATION_MAX_DISTANCE` characters of it.
 */
const VERIFICATION_KEYWORD = { reason: "verification", pattern: /\bverification\b/gi };
const NEAR_VERIFICATION_MAX_DISTANCE = 60;

/** A digit run that reads as the duration in "expire(s) within N minutes", not a code. */
const FOLLOWED_BY_MINUTES = /^[\s-]*minutes?\b/i;
/** A bare 4-digit run right after "Copyright"/"©" reads as a year, not a code. */
const YEAR_CONTEXT = /(?:copyright|©)\s*$/i;
/**
 * A digit run immediately glued to a hyphen is a segment of a formatted
 * phone number.
 *
 * `security/detect-object-injection` warns on both indices: false positive.
 * `index` and `end` are `OTP_DIGITS`' own match position and match end, not
 * attacker-chosen keys, so this can never read an arbitrary property.
 */
function isPhoneSegment(text: string, index: number, end: number): boolean {
  return text[index - 1] === "-" || text[end] === "-";
}

/**
 * Whether a 4-8 digit run at `index` is one of the shapes that is never an
 * OTP: an expiry duration, a calendar year next to a copyright notice, or a
 * segment of a hyphen-formatted phone number. A digit run longer than 8 is
 * never even a candidate -- `\b\d{4,8}\b`'s own word boundaries cannot match
 * inside a longer run of digits, since there is no non-digit boundary
 * between its interior characters.
 */
function isExcludedDigits(text: string, index: number, value: string): boolean {
  const end = index + value.length;
  if (FOLLOWED_BY_MINUTES.test(text.slice(end, end + 12)) || isPhoneSegment(text, index, end)) {
    return true;
  }
  const looksLikeYear = value.length === 4 && /^(?:19|20)\d{2}$/.test(value);
  return looksLikeYear && YEAR_CONTEXT.test(text.slice(Math.max(0, index - 20), index));
}

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

/** Every 4-8 digit run in `text` that survives `isExcludedDigits`. */
function findOtpDigitCandidates(text: string): Candidate[] {
  // eslint-disable-next-line unicorn/prefer-iterator-to-array -- see extractCodeNear above.
  return [...text.matchAll(OTP_DIGITS)]
    .map((match) => ({ value: match[0], index: match.index }))
    .filter((candidate) => !isExcludedDigits(text, candidate.index, candidate.value));
}

/** Every occurrence of `pattern` in `text`, as anchor positions. */
function keywordAnchors(text: string, pattern: RegExp): number[] {
  // eslint-disable-next-line unicorn/prefer-iterator-to-array -- see extractCodeNear above.
  return [...text.matchAll(pattern)].map((match) => match.index);
}

/**
 * The best candidate among `candidates` for one keyword's `anchors`, or null
 * when there are no anchors (the keyword did not match) or no candidates at
 * all.
 *
 * Prefers the nearest candidate that appears *after* an anchor -- a value
 * normally follows the word that names it ("token is 315046", "code is
 * 719284") -- over plain nearest-by-raw-distance. Raw distance alone is not
 * safe: in "Reference 20260922. Your one-time code is 719284.", the
 * reference number sits fewer characters from the anchor "one-time" than the
 * real code does, purely because it happens to come first in the sentence.
 * Falls back to nearest-by-raw-distance, in either direction, only when no
 * candidate follows any anchor at all -- so a value that (unusually)
 * precedes its keyword is still found rather than dropped.
 */
function pickNearestCandidate(candidates: Candidate[], anchors: number[]): string | null {
  if (anchors.length === 0) return null;
  const first = candidates[0];
  if (first === undefined) return null;

  let bestForward: Candidate | undefined;
  let bestForwardDistance = Infinity;
  let bestAny = first;
  let bestAnyDistance = Infinity;
  for (const candidate of candidates) {
    for (const anchor of anchors) {
      const distance = candidate.index - anchor;
      if (distance >= 0 && distance < bestForwardDistance) {
        bestForwardDistance = distance;
        bestForward = candidate;
      }
      const absDistance = Math.abs(distance);
      if (absDistance >= bestAnyDistance) continue;
      bestAnyDistance = absDistance;
      bestAny = candidate;
    }
  }
  return (bestForward ?? bestAny).value;
}

/**
 * Find an OTP in `text`: a keyword from `OTP_KEYWORDS` (checked in priority
 * order, so "verification token" wins over the weaker "token" it contains),
 * or -- failing all of those -- the word "verification" with a digit run
 * nearby. Returns null when no keyword matches, or a keyword matches but no
 * un-excluded digit run exists at all (a hint word alone is not enough: see
 * `isExcludedDigits` and the "code of conduct" test).
 */
function extractOtp(text: string): { code: string; reason: string } | null {
  const candidates = findOtpDigitCandidates(text);
  if (candidates.length === 0) return null;

  for (const keyword of OTP_KEYWORDS) {
    const code = pickNearestCandidate(candidates, keywordAnchors(text, keyword.pattern));
    if (code !== null) return { code, reason: keyword.reason };
  }

  const verificationAnchors = keywordAnchors(text, VERIFICATION_KEYWORD.pattern);
  const nearby = candidates.filter((candidate) =>
    verificationAnchors.some(
      (anchor) => Math.abs(candidate.index - anchor) <= NEAR_VERIFICATION_MAX_DISTANCE,
    ),
  );
  const code = pickNearestCandidate(nearby, verificationAnchors);
  return code === null ? null : { code, reason: VERIFICATION_KEYWORD.reason };
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
      reason: null,
    };
  }

  const otp = extractOtp(combined);
  return otp === null
    ? { kind: "other", code: null, url: null, reason: null }
    : { kind: "otp", code: otp.code, url: null, reason: otp.reason };
}
