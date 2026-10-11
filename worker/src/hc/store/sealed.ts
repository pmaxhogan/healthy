/**
 * Sealing for the Health Connect tables: JSON, gzip-compressed, in a `v3:` byte
 * envelope (`sealBytes`, worker/src/db/crypto.ts). Every `payload_enc` of the
 * store goes through this pair, so each is opened the one way it was sealed.
 */

import { aadFor, openBytes, sealBytes } from "../../db/crypto.ts";
import { AppError } from "../../lib/errors.ts";
import { gunzipText, gzipText } from "../codec.ts";

import type { Ctx } from "../../db/client.ts";

/**
 * The largest sealed value written to one row. D1 refuses a string or a row
 * over two million bytes; this leaves room for the row's other columns.
 */
const MAX_SEALED_CHARS = 1_900_000;

/**
 * A failure of the store that retrying cannot fix. The apply pipeline turns it
 * into a failed batch with `errorCode`, instead of a batch retried for ever.
 */
export class HcStoreError extends Error {
  constructor(readonly errorCode: string) {
    super(errorCode);
    this.name = "HcStoreError";
  }
}

/** The AAD of one sealed payload: the table, and the row's key joined by `:`. */
export function payloadAad(table: string, ...keyParts: (string | number)[]): string {
  return aadFor(table, "payload_enc", keyParts.map(String).join(":"));
}

/**
 * Seal a small JSON value: a rollup, a minute row, a summary. Chunks, which
 * can outgrow a row, are split instead (worker/src/hc/store/chunks.ts).
 */
export async function sealJson(
  ctx: Pick<Ctx, "env">,
  value: unknown,
  aad: string,
): Promise<string> {
  const sealed = await sealBytes(ctx.env, await gzipText(JSON.stringify(value)), aad);
  // Said out loud rather than left to D1 to refuse: nothing is stored cut short.
  if (sealed.length > MAX_SEALED_CHARS) throw new HcStoreError("payload_too_large");
  return sealed;
}

export async function openJson(
  ctx: Pick<Ctx, "env">,
  sealed: string,
  aad: string,
): Promise<unknown> {
  const bytes = await openBytes(ctx.env, sealed, aad);
  try {
    return JSON.parse(await gunzipText(bytes)) as unknown;
  } catch {
    // Opened, and not what this module seals: no retry will make it so.
    throw new HcStoreError("payload_malformed");
  }
}

/**
 * The stable code of a failure that retrying cannot fix -- a payload that will
 * not open, or is not what was sealed -- or null for anything that might pass.
 */
export function permanentStoreCode(error: unknown): string | null {
  if (error instanceof HcStoreError) return error.errorCode;
  return error instanceof AppError && error.code === "crypto" ? "crypto" : null;
}
