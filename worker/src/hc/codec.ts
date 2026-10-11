/**
 * JSON as gzip bytes: the plaintext form of every bulk payload the Health
 * Connect store seals (`sealBytes` / `openBytes`, worker/src/db/crypto.ts).
 *
 * An hour of records is repetitive JSON and compresses about tenfold, which is
 * the difference between a year of heart rate fitting comfortably in D1 and
 * not. Compression happens before sealing because ciphertext does not compress.
 *
 * The same pair reads a queued batch: the phone's request body is gzip JSON
 * and is queued exactly as it arrived.
 *
 * `CompressionStream` and `Response` only, so this runs in workerd and in the
 * plain-Node unit tests alike.
 */

async function pipe(
  bytes: Uint8Array<ArrayBuffer>,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array<ArrayBuffer>> {
  const { body } = new Response(bytes);
  if (body === null) return new Uint8Array(0);
  // `arrayBuffer()` allocates a plain ArrayBuffer, which is what WebCrypto
  // wants of the result (see `fromBase64` in worker/src/db/crypto.ts).
  return new Uint8Array(await new Response(body.pipeThrough(transform)).arrayBuffer());
}

/** gzip of a string's UTF-8 bytes. */
export async function gzipText(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const encoded = new TextEncoder().encode(text);
  const plain = new Uint8Array(encoded.length);
  plain.set(encoded);
  return pipe(plain, new CompressionStream("gzip"));
}

/**
 * The inverse of `gzipText`. Throws on bytes that are not a gzip stream and on
 * a stream that is not UTF-8; a caller reading something it did not write
 * itself (a queued batch) treats either as "cannot be read", not as a crash.
 */
export async function gunzipText(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const plain = await pipe(bytes, new DecompressionStream("gzip"));
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plain);
}

/** A JSON value as gzip bytes. */
export async function packJson(value: unknown): Promise<Uint8Array<ArrayBuffer>> {
  return gzipText(JSON.stringify(value));
}

/** The inverse of `packJson`. Throws when the bytes are not gzip JSON. */
export async function unpackJson(bytes: Uint8Array<ArrayBuffer>): Promise<unknown> {
  return JSON.parse(await gunzipText(bytes)) as unknown;
}
