// `portal_message_attachments` and its chunks, against the real schema, real D1
// value limits and real WebCrypto.
//
// What matters: a file comes back byte for byte however large -- cut into
// pieces that each fit D1 -- with nothing readable in the clear; a failure is a
// row, retried only after a day and never over a stored file; attachment keys
// come from message content, so one message's attachments have the same public
// id from either portal; and deleting a health system's attachments takes the
// pieces too. Every file is synthetic.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  CHUNK_BASE64_CHARS,
  RETRY_FAILED_AFTER_SECONDS,
  base64Pieces,
} from "../../../src/db/repos/portal-message-attachments.ts";
import { base64ToBytes, bytesToBase64 } from "../../../src/lib/base64.ts";

import { clock, resetDb, seedHealthSystem, testRepos } from "./helpers.ts";

import type { PortalThread } from "../../../src/ehr/mychart/index.ts";

beforeEach(resetDb);

/** Deterministic, incompressible-looking bytes. */
function bytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = 7;
  for (let index = 0; index < length; index++) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    out[index] = state % 256;
  }
  return out;
}

describe("the base64 pieces", () => {
  it("round-trips, and cuts on whole base64 quanta", () => {
    const file = bytes(1000);
    expect([...base64ToBytes(bytesToBase64(file))]).toStrictEqual([...file]);
    expect(CHUNK_BASE64_CHARS % 4).toBe(0);
    expect(base64Pieces("")).toStrictEqual([""]);
    expect(
      base64Pieces("a".repeat(CHUNK_BASE64_CHARS + 4)).map((piece) => piece.length),
    ).toStrictEqual([CHUNK_BASE64_CHARS, 4]);
  });
});

describe("portal_message_attachments", () => {
  it("stores a file larger than one D1 value, byte for byte, sealed", async () => {
    const repos = testRepos();
    const id = await seedHealthSystem(repos);
    // Just over two pieces: every piece near the 1 MiB bucket, the last one short.
    const file = bytes(2 * 589_824 + 1234);

    const { chunks } = await repos.portalMessageAttachments.store(
      id,
      "key-1",
      { name: "invented-scan", extension: "PDF", contentType: "application/pdf" },
      file,
    );

    expect(chunks).toBe(3);
    const back = await repos.portalMessageAttachments.content(id, "key-1");
    expect(back?.length).toBe(file.length);
    expect(back?.every((value, index) => value === file[index])).toBe(true);
    const [row] = await repos.portalMessageAttachments.list(id);
    expect(row).toMatchObject({
      state: "stored",
      errorCode: null,
      meta: {
        name: "invented-scan",
        extension: "PDF",
        contentType: "application/pdf",
        size: file.length,
      },
    });
    const raw = await env.DB.prepare(
      "SELECT meta_enc, (SELECT group_concat(substr(data_enc, 1, 3)) FROM portal_message_attachment_chunks) AS heads FROM portal_message_attachments",
    ).first<{ meta_enc: string; heads: string }>();
    expect(raw?.meta_enc).not.toContain("invented-scan");
    expect(raw?.heads).toBe("v2:,v2:,v2:");
  });

  it("records a failure, retries it only after a day, and never fails over a stored file", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const id = await seedHealthSystem(repos);

    await repos.portalMessageAttachments.fail(id, "key-1", { name: "a" }, "portal_parse_failed");
    await repos.portalMessageAttachments.store(id, "key-2", { name: "b" }, bytes(10));

    expect([
      ...(await repos.portalMessageAttachments.needingFetch(id, ["key-1", "key-2", "key-3"])),
    ]).toStrictEqual(["key-3"]);
    time.advance(RETRY_FAILED_AFTER_SECONDS);
    expect([
      ...(await repos.portalMessageAttachments.needingFetch(id, ["key-1", "key-2"])),
    ]).toStrictEqual(["key-1"]);

    await repos.portalMessageAttachments.fail(id, "key-2", { name: "b" }, "portal_unreachable");
    const rows = await repos.portalMessageAttachments.list(id);
    expect(rows.find((row) => row.attachmentKey === "key-2")?.state).toBe("stored");
    expect(await repos.portalMessageAttachments.content(id, "key-1")).toBeNull();
  });

  it("forgets every attachment and every piece of a health system", async () => {
    const repos = testRepos();
    const id = await seedHealthSystem(repos);
    await repos.portalMessageAttachments.store(id, "key-1", {}, bytes(10));

    await repos.portalMessageAttachments.clearHealthSystem(id);

    expect(await repos.portalMessageAttachments.list(id)).toStrictEqual([]);
    const pieces = await env.DB.prepare(
      "SELECT count(*) AS n FROM portal_message_attachment_chunks",
    ).first<{ n: number }>();
    expect(pieces?.n).toBe(0);
  });
});

/** One message with one fetchable attachment, first-party or a second-hand copy. */
function thread(external: boolean): PortalThread {
  return {
    subject: "Invented subject",
    folder: "conversations",
    external,
    practitioners: [],
    messages: [
      {
        sent: "2026-03-01T12:00:00.000Z",
        role: "practitioner",
        body: "An invented reply.",
        unread: false,
        attachments: [
          {
            name: "invented-sheet",
            extension: "PDF",
            handle: { dcsId: "WP-per-session", fileExtension: "PDF", organizationId: "" },
          },
        ],
      },
    ],
  };
}

describe("attachment keys from portal_messages", () => {
  it("hands the pass each fetchable file, gives both portals one public id, and stores no handle", async () => {
    const repos = testRepos();
    const first = await seedHealthSystem(repos);
    const second = await seedHealthSystem(repos, { displayName: "Other Example" });

    const report = await repos.portalMessages.record(first, [thread(false)], { complete: true });
    await repos.portalMessages.record(second, [thread(true)], { complete: true });

    expect(report.attachments).toStrictEqual([
      expect.objectContaining({
        handle: { dcsId: "WP-per-session", fileExtension: "PDF", organizationId: "" },
        name: "invented-sheet",
        unread: false,
      }),
    ]);
    const [a] = await repos.portalMessages.list(first);
    const [b] = await repos.portalMessages.list(second);
    expect(a?.attachments[0]?.key).toBe(report.attachments[0]?.key);
    expect(a?.attachments[0]?.id).toBe(b?.attachments[0]?.id);
    expect(a?.attachments[0]?.key).not.toBe(b?.attachments[0]?.key);
    expect(a?.message.attachments).toStrictEqual([{ name: "invented-sheet", extension: "PDF" }]);
  });
});
