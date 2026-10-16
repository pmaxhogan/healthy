/**
The byte budget's cursor.

A Health Connect tool answers with at most `max_bytes` of rows (25 kB unless
the caller says otherwise) and, when that cut something off, a `cursor`.
The cursor is stateless: nothing is stored between the two calls. It holds

 - `q`: a digest of the tool name and every argument that decides WHICH rows
   the answer has and in what order, followed (after a `.`) by a stamp of
   the store as it stood when the cursor was issued ({@link storeStamp}).
   A cursor passed back with a different question is refused
   (`invalid_cursor`); one passed back after the phone's data changed is
   refused too, as `cursor_expired` -- a continuation recomputes the answer
   and skips what was already sent, so over a store that moved in between
   it would silently skip or repeat rows.
 - `o`: how many rows of this call's array to skip.
 - `a`, `hc_records` only: the start time of the next row, so the
   continuation reads the store from there and not from the beginning. `o`
   is then the number of rows already returned that share that start time,
   and `e` the number returned before them, which the continuation never
   reads again but still counts in `total`.
 - `u`, `data_quality` only: where the page being continued STOPPED reading.
   That tool walks a long range a window at a time and stops when a page is
   full, so a page is the findings of `[a, u)`. A cursor cut inside those
   rows carries both and `o` rows to skip, and the continuation reads
   exactly that stretch again; a cursor issued after the last row of a page
   carries only `a` (the old `u`) and starts a fresh page there.

`limit` and `max_bytes` are not part of the digest: they decide how much of
the sequence one call carries, not what the sequence is, so a caller may
change either between pages.

The encoding is base64url of JSON. It is not a secret and not signed: a
caller who edits one gets a different page of rows the same call could have
returned anyway.
*/

import { sha256Hex } from "../../sync/hash.ts";

import type { HcReads } from "./reads.ts";

/** Bytes of serialised `items` a Health Connect tool returns unless told otherwise. */
export const DEFAULT_MAX_BYTES = 25_000;

/** Arguments that page a result without changing it. */
const PAGING_ARGUMENTS: ReadonlySet<string> = new Set(["cursor", "limit", "max_bytes"]);

const CURSOR_VERSION = 1;

/** What separates the question's digest from the store's stamp inside `q`. */
const STAMP_SEPARATOR = ".";

export interface OpenedCursor {
  /** Rows of this call's array to skip. */
  offset: number;
  /** Epoch ms to resume reading from, when the tool's cursor carries one. */
  anchorMs: number | null;
  /** Rows of the whole answer that come before this call's array. */
  before: number;
  /** Epoch ms the page being continued stopped reading at, when the cursor carries it. */
  untilMs?: number;
}

/** Where a call without a cursor starts. */
const START: OpenedCursor = { offset: 0, anchorMs: null, before: 0 };

/** `value` with its keys in a fixed order at every depth, so equal arguments digest equally. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return (value as unknown[]).map((entry) => canonical(entry));
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  entries.sort(([left], [right]) => (left < right ? -1 : 1));
  return Object.fromEntries(entries.map(([key, entry]) => [key, canonical(entry)]));
}

/** The digest a cursor is bound to: this tool, asked this question. */
export async function cursorDigest(tool: string, args: Record<string, unknown>): Promise<string> {
  const question = Object.fromEntries(
    Object.entries(args).filter(([key]) => !PAGING_ARGUMENTS.has(key)),
  );
  const digest = await sha256Hex(JSON.stringify([tool, canonical(question)]));
  return digest.slice(0, 16);
}

/**
A stamp of the store for the phones a call reads: it changes whenever an
upload arrives, is applied, is set aside, or a rollup is rebuilt. Built
from bookkeeping only -- instants and counts -- and hashed, so the cursor
that carries it says nothing about the phone.
*/
async function storeStamp(
  reads: HcReads,
  devices: readonly { id: string; lastUploadAt: number | null }[],
): Promise<string> {
  const parts: unknown[] = [];
  for (const device of devices) {
    const backlog = await reads.backlog(device.id);
    const [newest] = await reads.ingestLog(device.id, 1);
    parts.push([
      device.id,
      device.lastUploadAt,
      newest?.receivedAt ?? null,
      newest?.appliedAt ?? null,
      newest?.status ?? null,
      backlog.queuedBatches,
      backlog.parkedBatches,
      backlog.dirty,
      backlog.rezonePending,
    ]);
  }
  const digest = await sha256Hex(JSON.stringify(parts));
  return digest.slice(0, 12);
}

function toBase64Url(text: string): string {
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(text: string): string | null {
  try {
    return atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return null;
  }
}

export interface CursorPosition {
  /** Rows of the continuation's array to skip. */
  offset: number;
  /** Epoch ms the continuation resumes reading from, or null to read the whole range. */
  anchorMs?: number | null;
  /** Rows before the continuation's array, which it will not read again. */
  before?: number;
  /** Epoch ms the continuation must read up to and no further, or null for no fixed end. */
  untilMs?: number | null;
}

/** The cursor that resumes at `position` (a plain row offset when given a number). */
export function writeCursor(digest: string, position: number | CursorPosition): string {
  const {
    offset,
    anchorMs = null,
    before = 0,
    untilMs = null,
  } = typeof position === "number" ? { offset: position } : position;
  return toBase64Url(
    JSON.stringify({
      v: CURSOR_VERSION,
      q: digest,
      o: offset,
      ...(anchorMs !== null && { a: anchorMs }),
      ...(before > 0 && { e: before }),
      ...(untilMs !== null && { u: untilMs }),
    }),
  );
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The fields of a cursor, or null for anything that is not one. */
function decode(cursor: string): { q: string; position: OpenedCursor } | null {
  const json = fromBase64Url(cursor);
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { v, q, o, a, e, u } = parsed as Record<string, unknown>;
  if (v !== CURSOR_VERSION || typeof q !== "string" || !isCount(o)) return null;
  const optional = [a, e, u];
  if (optional.some((field) => field !== undefined && !isCount(field))) return null;
  return {
    q,
    position: {
      offset: o,
      anchorMs: isCount(a) ? a : null,
      before: isCount(e) ? e : 0,
      ...(isCount(u) && { untilMs: u }),
    },
  };
}

/**
Open the caller's cursor. No cursor is the start; null means it is not a
cursor this tool issued for these arguments.
*/
export function readCursor(cursor: string | undefined, digest: string): OpenedCursor | null {
  if (cursor === undefined) return START;
  const decoded = decode(cursor);
  return decoded?.q === digest ? decoded.position : null;
}

/** A caller's cursor, opened and bound to this call's question and to the store as it stands. */
export interface StampedPage extends OpenedCursor {
  /** The question's digest and the store's stamp: what a cursor issued now is bound to. */
  digest: string;
}

export type OpenedPage =
  | { ok: true; page: StampedPage }
  /** `invalid_cursor`: another question's. `cursor_expired`: this question's, over a store that has since changed. */
  | { ok: false; errorCode: "invalid_cursor" | "cursor_expired" };

/**
Open `args.cursor` against the question AND the store: the same question
over a store that has changed since the cursor was issued is
`cursor_expired`, so a caller restarts instead of reading pages that no
longer line up.
*/
export async function openStampedPage(
  reads: HcReads,
  devices: readonly { id: string; lastUploadAt: number | null }[],
  tool: string,
  args: Record<string, unknown>,
): Promise<OpenedPage> {
  const question = await cursorDigest(tool, args);
  const digest = `${question}${STAMP_SEPARATOR}${await storeStamp(reads, devices)}`;
  const cursor = typeof args.cursor === "string" ? args.cursor : undefined;
  if (cursor === undefined) return { ok: true, page: { digest, ...START } };
  const decoded = decode(cursor);
  if (decoded === null) return { ok: false, errorCode: "invalid_cursor" };
  if (decoded.q === digest) return { ok: true, page: { digest, ...decoded.position } };
  const sameQuestion = decoded.q.startsWith(`${question}${STAMP_SEPARATOR}`);
  return { ok: false, errorCode: sameQuestion ? "cursor_expired" : "invalid_cursor" };
}
