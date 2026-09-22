import { describe, expect, it } from "vitest";

import { normalizeDocumentReference } from "../../../../worker/fhir/normalize/document-reference.ts";

import { testCtx } from "./fixtures.ts";

import type * as fhir4 from "fhir/r4";

describe("normalizeDocumentReference", () => {
  it("maps type/category/author and a relative Binary attachment url", () => {
    const resource: fhir4.DocumentReference = {
      resourceType: "DocumentReference",
      id: "doc-1",
      status: "current",
      type: { text: "Progress Note" },
      category: [{ text: "Clinical Note" }],
      date: "2026-07-01T12:00:00Z",
      description: "Follow-up visit note",
      author: [{ reference: "Practitioner/prac-1" }],
      content: [
        {
          attachment: { contentType: "text/plain", url: "Binary/xyz", title: "Progress Note" },
        },
      ],
    };

    const result = normalizeDocumentReference(resource, testCtx());

    expect(result).toMatchObject({
      resourceType: "DocumentReference",
      id: "doc-1",
      type: "Progress Note",
      category: ["Clinical Note"],
      date: "2026-07-01T12:00:00Z",
      status: "current",
      description: "Follow-up visit note",
      author: ["Dr. Ada Example"],
    });
    expect(result.attachments).toEqual([
      { contentType: "text/plain", url: "Binary/xyz", title: "Progress Note" },
    ]);
  });

  it("carries an absolute attachment url through unchanged", () => {
    const resource: fhir4.DocumentReference = {
      resourceType: "DocumentReference",
      id: "doc-2",
      status: "current",
      content: [{ attachment: { url: "https://fhir.example.org/api/FHIR/R4/Binary/xyz" } }],
    };

    expect(normalizeDocumentReference(resource, testCtx()).attachments).toEqual([
      { url: "https://fhir.example.org/api/FHIR/R4/Binary/xyz" },
    ]);
  });
});
