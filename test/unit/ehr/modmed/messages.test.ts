// ModMed intramail rows -> the shared portal message model.

import { describe, expect, it } from "vitest";

import {
  conversationKey,
  conversationsOf,
  threadOf,
  threadsOf,
} from "../../../../worker/ehr/modmed/messages.ts";

import { inboxRow, sentRow } from "./fixtures.ts";

describe("threadOf", () => {
  it("reads an inbox row as a practitioner's message, body flattened, attachment kept", () => {
    expect(threadOf(inboxRow(), "inbox")).toStrictEqual({
      subject: "RE: Question about my results",
      folder: "conversations",
      external: false,
      practitioners: [{ name: "Example Nurse" }],
      messages: [
        {
          sent: "2026-09-02T15:00:00.000Z",
          role: "practitioner",
          author: "Example Nurse",
          body: expect.stringContaining("Your results look normal.") as string,
          attachments: [
            {
              name: "results-letter.pdf",
              extension: "PDF",
              handle: { dcsId: "801", fileExtension: "PDF", organizationId: "" },
            },
          ],
          unread: false,
        },
      ],
    });
  });

  it("keeps the owner's unread flag, and never a patient recipient's name", () => {
    const thread = threadOf(inboxRow({ currentRecipientFlags: { messageRead: false } }), "inbox");
    expect(thread?.messages[0]?.unread).toBe(true);
    expect(JSON.stringify(thread)).not.toContain("Test Patient");
  });

  it("reads a sent row as the patient's, addressed to the care-team group", () => {
    const thread = threadOf(sentRow(), "sent");
    expect(thread?.messages[0]).toMatchObject({
      role: "patient",
      unread: false,
      body: "Could you explain my results?",
    });
    expect(thread?.practitioners).toStrictEqual([{ name: "Example Clinic Nurses" }]);
  });

  it("skips drafts, rows with no date, and anything that is not a row", () => {
    expect(threadOf(sentRow({ isDraft: true }), "sent")).toBeNull();
    expect(threadOf(sentRow({ received: undefined, dateCreated: "soon" }), "sent")).toBeNull();
    expect(threadsOf(["junk", null, sentRow()], "sent")).toHaveLength(1);
  });

  it("drops a deleted attachment", () => {
    const thread = threadOf(
      inboxRow({ fileAttachments: [{ id: 1, fileName: "x.pdf", deleted: true }] }),
      "inbox",
    );
    expect(thread?.messages[0]?.attachments).toStrictEqual([]);
  });
});

describe("conversationsOf", () => {
  it("joins a reply to the message it answers, oldest first, by subject", () => {
    const merged = conversationsOf([
      ...threadsOf([inboxRow()], "inbox"),
      ...threadsOf([sentRow()], "sent"),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.subject).toBe("Question about my results");
    expect(merged[0]?.messages.map((message) => message.role)).toStrictEqual([
      "patient",
      "practitioner",
    ]);
    expect(merged[0]?.practitioners).toStrictEqual([
      { name: "Example Clinic Nurses" },
      { name: "Example Nurse" },
    ]);
  });

  it("keeps different subjects, and subjectless messages, apart", () => {
    const merged = conversationsOf([
      ...threadsOf(
        [inboxRow({ subject: "Appointment reminder" }), inboxRow({ subject: "", id: 2 })],
        "inbox",
      ),
      ...threadsOf([sentRow()], "sent"),
    ]);
    expect(merged).toHaveLength(3);
  });

  it("normalises reply and forward prefixes, case and spacing", () => {
    expect(conversationKey("RE: re:  FW: Fwd:Question   about it")).toBe("question about it");
    expect(conversationKey("Question about it")).toBe("question about it");
  });
});
