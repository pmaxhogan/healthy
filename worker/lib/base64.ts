/**
 * Bytes to and from standard base64, for files: an attachment's stored pieces
 * (`worker/db/repos/portal-message-attachments.ts`) and an MCP image content
 * block (`worker/mcp/message-attachment.ts`). Pure, no bindings.
 */

/** Bytes per `String.fromCodePoint` call: far below any engine's argument limit. */
const SLICE = 0x80_00;

/** Bytes to standard base64, in slices so a large file never builds one huge argument list. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += SLICE) {
    binary += String.fromCodePoint(...bytes.subarray(offset, offset + SLICE));
  }
  return btoa(binary);
}

/** The inverse of {@link bytesToBase64}. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) out[index] = binary.codePointAt(index) ?? 0;
  return out;
}
