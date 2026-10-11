// The Message Center crawl, against a synthetic mailbox with the real API's
// paging rules (`message-fixtures.ts`).
//
// What matters: every folder, every organisation and every page is read to the
// end; every message of every conversation, older pages included; nothing is
// kept twice; a page that makes no progress is an error, not a loop; the portal's
// HTML never survives into a body; and each message's author is who the portal
// says it is.

import { describe, expect, it } from "vitest";

import { loadMessageCenter } from "../../../../src/ehr/mychart/messages.ts";
import { MESSAGE_FOLDERS, PATHS } from "../../../../src/ehr/mychart/wire.ts";

import {
  DOCTOR_KEY,
  EXTERNAL_ORG,
  LOCAL_ORG,
  NURSE_KEY,
  PROXY_KEY,
  SECOND_EXTERNAL_ORG,
  SELF_KEY,
  answerMessageCenter,
  message,
  messageCenter,
} from "./message-fixtures.ts";

import type { FixtureConversation, MessageCenterState } from "./message-fixtures.ts";
import type { AppError } from "../../../../src/lib/errors.ts";

const NONCE = "0123456789abcdef0123456789abcdef";

function load(state: MessageCenterState) {
  return loadMessageCenter({
    post: (path, _label, body) =>
      Promise.resolve(answerMessageCenter(state, path, body as Record<string, unknown>)),
    nonce: () => NONCE,
  });
}

/** `count` one-message conversations in one organisation and folder. */
function many(orgId: string, tag: number, count: number, prefix: string): FixtureConversation[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${String(index)}`,
    organizationId: orgId,
    tag,
    subject: `Subject ${prefix} ${String(index)}`,
    messages: [message(`${prefix}-m${String(index)}`, 10_000 - index, { empKey: NURSE_KEY })],
  }));
}

describe("loadMessageCenter paging", () => {
  it("reads every page of every organisation in every folder, keeping each conversation once", async () => {
    const state = messageCenter({
      organizations: [
        { id: LOCAL_ORG, name: "Example Health", local: true },
        { id: EXTERNAL_ORG, name: "Other Example Clinic", local: false },
        { id: SECOND_EXTERNAL_ORG, name: "Third Example Group", local: false },
      ],
      pageSize: 3,
      conversations: [
        ...many(LOCAL_ORG, 1, 7, "local"),
        ...many(EXTERNAL_ORG, 1, 5, "ext"),
        ...many(SECOND_EXTERNAL_ORG, 6, 4, "auto"),
        ...many(LOCAL_ORG, 2, 1, "archived"),
      ],
    });

    const result = await load(state);

    expect(result.complete).toBe(true);
    expect(result.threads).toHaveLength(17);
    const subjects = result.threads.map((thread) => thread.subject);
    expect(new Set(subjects).size).toBe(17);
    expect(result.threads.filter((thread) => thread.folder === "automated")).toHaveLength(4);
    expect(result.threads.filter((thread) => thread.folder === "archive")).toHaveLength(1);
    // Every folder was asked for, and every external organisation on the first page.
    const lists = state.requests.filter((request) => request.path === PATHS.conversationList);
    expect(new Set(lists.map((request) => request.body.tag))).toStrictEqual(
      new Set(MESSAGE_FOLDERS.map((folder) => folder.tag)),
    );
    const firstPages = lists.filter(
      (entry) =>
        (entry.body.localLoadParams as { loadStartInstantISO?: string } | null)
          ?.loadStartInstantISO === "",
    );
    expect(firstPages).toHaveLength(MESSAGE_FOLDERS.length);
    for (const request of firstPages) {
      expect(
        Object.keys(request.body.externalLoadParams as object).toSorted((a, b) =>
          a.localeCompare(b),
        ),
      ).toStrictEqual([EXTERNAL_ORG, SECOND_EXTERNAL_ORG].toSorted((a, b) => a.localeCompare(b)));
    }
    expect(lists.every((request) => request.body.PageNonce === NONCE)).toBe(true);
  });

  it("asks for the next page from the oldest loaded instant", async () => {
    const state = messageCenter({ pageSize: 2, conversations: many(LOCAL_ORG, 1, 3, "p") });

    await load(state);

    const lists = state.requests.filter(
      (request) => request.path === PATHS.conversationList && request.body.tag === 1,
    );
    expect(lists).toHaveLength(2);
    const second = lists[1]?.body.localLoadParams as Record<string, unknown>;
    expect(second.loadStartInstantISO).not.toBe("");
    expect(second.loadEndInstantISO).toBe("");
  });

  it("reads a long conversation's older messages to the end, five at a time", async () => {
    const messages = Array.from({ length: 13 }, (_, index) =>
      message(
        `long-${String(index)}`,
        index,
        index % 2 === 0 ? { wprKey: SELF_KEY } : { empKey: DOCTOR_KEY },
      ),
    );
    const state = messageCenter({
      conversations: [
        { id: "long", organizationId: LOCAL_ORG, tag: 1, subject: "Long thread", messages },
      ],
    });

    const result = await load(state);

    const [thread] = result.threads;
    expect(thread?.messages).toHaveLength(13);
    // Oldest first.
    expect(thread?.messages.map((entry) => entry.sent)).toStrictEqual(
      messages.map((entry) => new Date(entry.sent).toISOString()),
    );
    const older = state.requests.filter((request) => request.path === PATHS.conversationMessages);
    expect(older).toHaveLength(2);
    for (const request of older) expect(request.body).not.toHaveProperty("maxReadMessages");
  });

  it("fails rather than looping when a page claims more but adds nothing", async () => {
    const state = messageCenter({
      pageSize: 1,
      stuck: true,
      conversations: many(LOCAL_ORG, 1, 3, "s"),
    });

    await expect(load(state)).rejects.toMatchObject({
      code: "portal_parse_failed",
    } satisfies Partial<AppError>);
  });

  it("says a read is incomplete when an organisation it asked for sent no summary", async () => {
    const state = messageCenter({
      conversations: many(LOCAL_ORG, 1, 1, "only"),
      silent: new Set([EXTERNAL_ORG]),
    });

    const result = await load(state);

    expect(result.complete).toBe(false);
    expect(result.threads).toHaveLength(1);
  });
});

describe("loadMessageCenter parsing", () => {
  it("names each author by role, from the list's own maps", async () => {
    const state = messageCenter({
      conversations: [
        {
          id: "c1",
          organizationId: LOCAL_ORG,
          tag: 1,
          subject: "Question",
          audience: ["Nurse Example A", "Nurse Example A"],
          messages: [
            message("m1", 1, { wprKey: SELF_KEY }),
            message("m2", 2, { empKey: NURSE_KEY }),
            message("m3", 3, { wprKey: PROXY_KEY }),
            message("m4", 4, { displayName: "Messaging System" }),
            message("m5", 5, { empKey: "emp-key-unlisted" }),
          ],
          overrides: { "emp-key-unlisted": "Staff Example C" },
        },
      ],
    });

    const { threads } = await load(state);
    const [thread] = threads;

    expect(thread?.messages.map((entry) => [entry.role, entry.author])).toStrictEqual([
      ["patient", "Test Person"],
      ["practitioner", "Nurse Example A"],
      ["proxy", "Test Proxy"],
      ["system", "Messaging System"],
      ["practitioner", "Staff Example C"],
    ]);
    expect(thread?.practitioners).toStrictEqual([{ name: "Nurse Example A" }]);
    expect(thread?.external).toBe(false);
    expect(thread).not.toHaveProperty("organization");
  });

  it("flattens the body to text: no markup, no CSS, entities decoded", async () => {
    const state = messageCenter({
      conversations: [
        {
          id: "c1",
          organizationId: LOCAL_ORG,
          tag: 1,
          subject: "Formatting",
          messages: [
            message(
              "m1",
              1,
              { empKey: NURSE_KEY },
              '<div><style nonce="x">p{margin:0}</style><p>Take it &#8211; twice&nbsp;daily.</p>' +
                "<ul><li>With food</li><li>At bedtime &amp; morning</li></ul>" +
                '<img src="/img?token=abc" alt="x"><a href="#" data-redirect="y">Link</a></div>',
            ),
          ],
        },
      ],
    });

    const { threads } = await load(state);
    const body = threads[0]?.messages[0]?.body;

    expect(body).toBe("Take it – twice daily.\n\n- With food\n- At bedtime & morning\nLink");
  });

  it("marks another organisation's conversation external, with its name, and keeps attachments' names and handles", async () => {
    const state = messageCenter({
      conversations: [
        {
          id: "x1",
          organizationId: EXTERNAL_ORG,
          tag: 1,
          subject: "Results",
          messages: [
            {
              ...message("xm1", 1, { empKey: DOCTOR_KEY }),
              attachments: [{ name: "invented-scan", fileExtension: "PDF" }],
            },
          ],
        },
      ],
    });

    const { threads } = await load(state);
    const [thread] = threads;

    expect(thread?.external).toBe(true);
    expect(thread?.organization).toBe("Other Example Clinic");
    // The handle is what the same run fetches the file with; it is never stored.
    expect(thread?.messages[0]?.attachments).toStrictEqual([
      {
        name: "invented-scan",
        extension: "PDF",
        handle: { dcsId: "dcs-xm1", fileExtension: "PDF", organizationId: "" },
      },
    ]);
  });

  it("keeps the portal's own unread flag on each message", async () => {
    const state = messageCenter({
      conversations: [
        {
          id: "u1",
          organizationId: LOCAL_ORG,
          tag: 1,
          subject: "Unread",
          messages: [
            { ...message("um1", 1, { empKey: DOCTOR_KEY }), unread: true },
            message("um2", 2, { empKey: DOCTOR_KEY }),
          ],
        },
      ],
    });

    const { threads } = await load(state);

    expect(threads[0]?.messages.map((entry) => entry.unread)).toStrictEqual([true, false]);
  });
});
