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
 * One entry, and it is not a health system: `"google.com"` is Gmail's own
 * forwarding-verification email, which is the one message that has to be
 * accepted before the owner has anything else to add. Their tenant's exact
 * sending domain is theirs to paste in once real mail arrives -- it names the
 * organisation, so it can have no default in source (see CLAUDE.md).
 *
 * It used to also ship `"mychart."`, a *fragment*, matched by containment. That
 * allowlisted every domain on the internet whose own label happened to contain
 * it (`mychart.attacker.example`), which let an unauthenticated stranger post
 * verification codes of their choosing into `mail_inbox`. Entries are full
 * domains now and matching is anchored -- see `domainAllowed`.
 */
export const DEFAULT_MAIL_SENDER_ALLOWLIST = ["google.com"] as const;

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
 * Whether `domain` is allowed by one of `allowlist`'s entries.
 *
 * Exact match, or a match anchored at a label boundary: an entry of
 * `example.org` allows `example.org` and `mychart.example.org`, and nothing
 * else. Never containment -- that is what let `mychart.attacker.example` past
 * an entry of `mychart.`, and `google.com.attacker.example` past `google.com`.
 * Both sides are lower-cased, so a mixed-case header or a mixed-case stored
 * entry compares the same way.
 *
 * Entries are expected to be domain-shaped with at least two labels
 * (`mailAllowlistSchema` enforces it on the way in); an entry that is not is
 * simply one nothing will ever equal or end with.
 */
export function domainAllowed(domain: string, allowlist: readonly string[]): boolean {
  const host = domain.trim().toLowerCase();
  if (host === "") return false;
  return allowlist.some((raw) => {
    const entry = raw.trim().toLowerCase();
    return entry !== "" && (host === entry || host.endsWith(`.${entry}`));
  });
}

/** Whether `from`'s domain is on the allowlist. See `domainAllowed`. */
export function isAllowedSender(from: string, allowlist: readonly string[]): boolean {
  return domainAllowed(domainOf(from), allowlist);
}

/**
 * How long a row of each kind is kept.
 *
 * Every kind has one. Before this, only `otp` did, and the purge only ever
 * deleted rows that had an `expires_at` -- so a `forward_verify` row, an
 * `other` row and every `POST /api/mail/test` row were retained for ever,
 * carrying a sender the owner never chose. A login code is useful for minutes;
 * Gmail's forwarding confirmation for as long as the owner takes to notice it;
 * an `other` row only long enough to answer "did that message arrive".
 */
const MAIL_TTL_SECONDS: Record<MailKind, number> = {
  otp: 600,
  forward_verify: 6 * 60 * 60,
  other: 24 * 60 * 60,
};

export function mailTtlSeconds(kind: MailKind): number {
  // A closed union indexing a const map, not a dynamic key.
  return MAIL_TTL_SECONDS[kind];
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
/**
 * The only host a `forward_verify` link may point at.
 *
 * The exact host Gmail's forwarding-confirmation link uses, not `*.google.com`:
 * that wider rule also admitted Google's own open redirector
 * (`https://www.google.com/url?q=…`), which would have put a link on the Mail
 * page that bounces the owner anywhere the message chose.
 */
const GMAIL_FORWARD_VERIFY_HOST = "mail-settings.google.com";
/**
 * Query parameters that turn a URL into a redirector.
 *
 * Belt and braces next to the host pin: the confirmation link carries none of
 * these, so a link that does is not the one this is for.
 */
const REDIRECTOR_PARAMS = ["q", "url", "continue"] as const;

/**
 * The most message text `classify` will look at.
 *
 * `MAX_RAW_SIZE_BYTES` in `worker/mail/handler.ts` allows a full megabyte, and
 * `pickNearestCandidate` is O(candidates x anchors) with both derived from the
 * body -- ~1 MB of `"1234 code "` is on the order of 10^10 iterations, which
 * hits the CPU limit and throws *before* the row is stored, so the message
 * tempfails and the sender retries it for ever. No real verification email is
 * anywhere near this, and a code that is past it is a code the portal did not
 * send.
 *
 * Exported so `worker/mail/parse.ts` can cap how much of an HTML-only
 * message it flattens to text before `classify` ever sees it, rather than
 * inventing a second magic number that could drift from this one.
 */
export const MAX_CLASSIFY_CHARS = 65_536;

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
 * Restricting the scheme (`https:` only, blocking `javascript:`, `data:` and
 * everything else), the host (the exact host Gmail's forwarding-confirmation
 * link uses -- not `*.google.com`, which also admits Google's own open
 * redirector) and any redirector parameter means a spoofed link never survives
 * classification, regardless of what the SPA does with it.
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
    url.hostname.toLowerCase() === GMAIL_FORWARD_VERIFY_HOST &&
    REDIRECTOR_PARAMS.every((param) => !url.searchParams.has(param))
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
  // Capped before any scanning: see `MAX_CLASSIFY_CHARS`.
  const combined = `${mail.subject}\n${mail.text}`.slice(0, MAX_CLASSIFY_CHARS);

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
