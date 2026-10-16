/**
Reading an upload without trusting anything it says about its own size.

Both limits are enforced on the bytes as they are read, never on a header:
`Content-Length` is a claim, and a gzip stream of a few kilobytes can expand
to gigabytes. Reading stops, and the stream is cancelled, the moment either
limit is passed.
*/

/** The largest compressed body the ingest route reads. */
export const MAX_COMPRESSED_BYTES = 8 * 1024 * 1024;
/**
The largest decompressed body it will expand one to. The compressed bytes,
the expanded bytes, the decoded string and the parsed tree are all alive at
once inside a 128 MB isolate, so this is set well under a quarter of that.
*/
export const MAX_RAW_BYTES = 16 * 1024 * 1024;

export type ReadResult =
  { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; reason: "too_large" | "malformed" };

/** Drain `stream` into one buffer, giving up once more than `maxBytes` have arrived. */
export async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<ReadResult> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    // A truncated or corrupt gzip stream surfaces here, as a read error.
    return { ok: false, reason: "malformed" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { ok: true, bytes };
}

/** Expand a gzip buffer, giving up once the output passes `maxBytes`. */
export async function gunzipCapped(
  compressed: Uint8Array<ArrayBuffer>,
  maxBytes: number,
): Promise<ReadResult> {
  const expanded = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
  return readCapped(expanded, maxBytes);
}
