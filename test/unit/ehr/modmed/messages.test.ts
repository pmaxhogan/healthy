// ModMed intramail rows -> the shared portal message model.

import { describe, expect, it } from "vitest";

import {
  conversationKey,
  messagesOf,
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

describe("messagesOf", () => {
  it("joins a reply to the message it answers, oldest first, by subject", () => {
    const { threads, undated } = messagesOf([inboxRow()], [sentRow()]);
    expect(undated).toBe(0);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.subject).toBe("Question about my results");
    expect(threads[0]?.messages.map((message) => message.role)).toStrictEqual([
      "patient",
      "practitioner",
    ]);
    expect(threads[0]?.practitioners).toStrictEqual([
      { name: "Example Clinic Nurses" },
      { name: "Example Nurse" },
    ]);
  });

  it("keeps different subjects, and subjectless messages, apart", () => {
    const { threads } = messagesOf(
      [inboxRow({ subject: "Appointment reminder" }), inboxRow({ subject: "", id: 2 })],
      [sentRow()],
    );
    expect(threads).toHaveLength(3);
  });

  it("does not join same-subject messages that are not a reply to one another", () => {
    // Two notices from the practice with one subject, and an owner's message
    // that shares it: no "RE:", so nothing is a reply to anything.
    const { threads } = messagesOf(
      [
        inboxRow({ id: 1, subject: "Office closure" }),
        inboxRow({ id: 2, subject: "Office closure", received: "2026-09-05T15:00:00.000+0000" }),
      ],
      [sentRow({ subject: "Office closure" })],
    );
    expect(threads).toHaveLength(3);
  });

  it("joins a reply only to an earlier message from the other folder, within the window", () => {
    const late = messagesOf(
      [inboxRow({ received: "2026-12-30T15:00:00.000+0000" })],
      [sentRow({ received: "2026-09-01T12:00:00.000+0000" })],
    );
    expect(late.threads).toHaveLength(2);
    const before = messagesOf(
      [inboxRow({ received: "2026-08-01T15:00:00.000+0000" })],
      [sentRow()],
    );
    expect(before.threads).toHaveLength(2);
    // Two replies in the inbox never join each other, only the sent original.
    const two = messagesOf([inboxRow({ id: 1 }), inboxRow({ id: 2 })], [sentRow()]);
    expect(two.threads).toHaveLength(1);
    expect(two.threads[0]?.messages).toHaveLength(3);
  });

  it("prefers messageLinks over the subject when a row carries them", () => {
    const { threads } = messagesOf(
      [inboxRow({ subject: "Something else entirely", messageLinks: [{ messageId: 6000 }] })],
      [sentRow()],
    );
    expect(threads).toHaveLength(1);
    expect(threads[0]?.messages).toHaveLength(2);
  });

  it("counts a row dropped for an unreadable date", () => {
    const { threads, undated } = messagesOf(
      [inboxRow({ received: "yesterday", dateCreated: undefined })],
      [sentRow()],
    );
    expect(undated).toBe(1);
    expect(threads).toHaveLength(1);
  });

  it("normalises reply and forward prefixes, case and spacing", () => {
    expect(conversationKey("RE: re:  FW: Fwd:Question   about it")).toBe("question about it");
    expect(conversationKey("Question about it")).toBe("question about it");
  });
});
