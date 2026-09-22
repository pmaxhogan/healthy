// Shared scaffolding for the email-handler integration tests: a fake
// `ForwardableEmailMessage` good enough for `handleInboundEmail` (raw MIME
// bytes, rawSize, and a `setReject` the test can inspect) and an `Env` built
// the same way `test/integration/db/helpers.ts` builds one, so a test can
// decrypt what the handler just sealed with the same `DATA_KEY`.

import { env as workerEnv } from "cloudflare:test";

import type { Env } from "../../../worker/env.ts";

export function randomDataKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCodePoint(...bytes));
}

/** An `Env` the handler can run against, sharing `dataKey` with the test's own repos. */
export function handlerEnv(dataKey: string): Env {
  // See test/integration/db/helpers.ts: the same HEALTHY_MCP narrowing cast applies.
  return { ...workerEnv, DATA_KEY: dataKey } as unknown as Env;
}

export interface FakeEmail {
  message: ForwardableEmailMessage;
  /** Every reason `setReject` was called with, in order. Empty if never. */
  rejections: string[];
}

/** A `ForwardableEmailMessage` good enough for `handleInboundEmail`, over a raw MIME string. */
export function fakeEmail(
  raw: string,
  options: { from?: string; to?: string; rawSizeOverride?: number } = {},
): FakeEmail {
  const rejections: string[] = [];
  const bytes = new TextEncoder().encode(raw);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const message: ForwardableEmailMessage = {
    from: options.from ?? "envelope-relay@example.test",
    to: options.to ?? "2fa@healthy.example.test",
    headers: new Headers(),
    raw: stream,
    rawSize: options.rawSizeOverride ?? bytes.byteLength,
    setReject(reason: string): void {
      rejections.push(reason);
    },
    forward(): Promise<EmailSendResult> {
      return Promise.resolve({ messageId: "fake-forward" });
    },
    reply(): Promise<EmailSendResult> {
      return Promise.resolve({ messageId: "fake-reply" });
    },
  };
  return { message, rejections };
}
