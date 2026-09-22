/**
 * Turns the raw MIME stream Cloudflare hands the `email()` handler into the
 * few fields the sign-in flow needs.
 *
 * postal-mime reads the whole message -- headers, HTML, attachments -- but
 * this repository's inbox never stores a body beyond its plain-text part and
 * never an attachment at all: `ParsedMail` is exactly what survives, and
 * `.html` / `.attachments` are dropped on the floor rather than threaded
 * through as unused fields that would tempt a later change to keep them.
 */

import PostalMime from "postal-mime";

export interface ParsedMail {
  /**
   * The message's own `From:` header address, lower-cased -- never the SMTP
   * envelope sender. `ForwardableEmailMessage.from` is the envelope, and a
   * Gmail filter's "Forward it to" rewrites that to Gmail's own relay
   * address while leaving this header alone; the header is the address the
   * sender allowlist has to match, or every Gmail-forwarded MyChart code
   * would be rejected. See .local/planb-research.md §1.
   */
  from: string;
  subject: string;
  text: string;
  receivedAt: number;
  rawSize: number;
}

/**
 * Parse one inbound message.
 *
 * `rawSize` and `receivedAt` are not part of the MIME content -- they come
 * from `ForwardableEmailMessage.rawSize` and the caller's clock -- but they
 * travel with the parsed fields because every caller needs both together to
 * build a `mail_inbox` row, and threading them separately through
 * `handler.ts` would just reassemble the same object one line later.
 */
export async function parseInboundEmail(
  raw: ReadableStream<Uint8Array> | ArrayBuffer | string,
  rawSize: number,
  receivedAt: number,
): Promise<ParsedMail> {
  const email = await PostalMime.parse(raw);
  return {
    from: (email.from?.address ?? "").trim().toLowerCase(),
    subject: (email.subject ?? "").trim(),
    text: email.text ?? "",
    receivedAt,
    rawSize,
  };
}
