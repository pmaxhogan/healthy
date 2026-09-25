// Turning an attachment into text. Pure functions, so pure tests.

import { describe, expect, it } from "vitest";

import {
  attachmentForBinary,
  binaryIdFromUrl,
  convertDocument,
  decodeBase64Utf8,
  htmlToText,
  isConvertible,
  isDocumentReference,
  parseDocumentTextId,
  pickAttachment,
  rtfToText,
} from "../../../worker/mcp/document-text.ts";

import type * as fhir4 from "fhir/r4";

const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");

/** A minimal, synthetic DocumentReference with one or more content entries. */
function documentReference(
  content: { contentType: string; url?: string; data?: string }[],
): fhir4.DocumentReference {
  return {
    resourceType: "DocumentReference",
    id: "doc-fixture",
    status: "current",
    content: content.map(({ contentType, url, data }) => ({
      attachment: {
        contentType,
        ...(url !== undefined && { url }),
        ...(data !== undefined && { data }),
      },
    })),
  };
}

describe("binaryIdFromUrl", () => {
  it("reads a relative Binary reference", () => {
    expect(binaryIdFromUrl("Binary/abc-123")).toBe("abc-123");
  });

  it("reads the id out of an absolute URL", () => {
    expect(binaryIdFromUrl("https://fhir.example.test/R4/Binary/abc-123")).toBe("abc-123");
  });

  it("stops at a query string or fragment", () => {
    expect(binaryIdFromUrl("Binary/abc-123?_id=1")).toBe("abc-123");
    expect(binaryIdFromUrl("Binary/abc-123#frag")).toBe("abc-123");
  });

  it("is undefined for a url with no Binary segment, or none at all", () => {
    expect(binaryIdFromUrl("DocumentReference/doc-1")).toBeUndefined();
    expect(binaryIdFromUrl(undefined)).toBeUndefined();
  });
});

describe("parseDocumentTextId", () => {
  it("classifies a relative Binary reference", () => {
    expect(parseDocumentTextId("Binary/bin-1")).toStrictEqual({ kind: "binary", id: "bin-1" });
  });

  it("classifies an absolute URL ending in a Binary reference", () => {
    expect(parseDocumentTextId("https://fhir.example.test/R4/Binary/bin-1")).toStrictEqual({
      kind: "binary",
      id: "bin-1",
    });
  });

  it("classifies a DocumentReference-prefixed id, stripping the prefix", () => {
    expect(parseDocumentTextId("DocumentReference/doc-1")).toStrictEqual({
      kind: "documentReference",
      id: "doc-1",
    });
  });

  it("classifies anything else as bare", () => {
    expect(parseDocumentTextId("doc-1")).toStrictEqual({ kind: "bare", id: "doc-1" });
  });
});

describe("isDocumentReference", () => {
  it("accepts a DocumentReference with a content array", () => {
    expect(isDocumentReference(documentReference([{ contentType: "text/plain" }]))).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isDocumentReference(null)).toBe(false);
    expect(isDocumentReference({ resourceType: "Patient" })).toBe(false);
    expect(isDocumentReference({ resourceType: "DocumentReference" })).toBe(false);
  });
});

describe("pickAttachment", () => {
  it("picks the first convertible attachment, inline data included", () => {
    const document = documentReference([
      { contentType: "application/pdf", url: "Binary/bin-pdf" },
      { contentType: "text/html", data: b64("<p>hi</p>") },
    ]);

    expect(pickAttachment(document)).toStrictEqual({
      contentType: "text/html",
      data: b64("<p>hi</p>"),
    });
  });

  it("carries the Binary id when the attachment is by reference", () => {
    const document = documentReference([{ contentType: "text/html", url: "Binary/bin-html" }]);

    expect(pickAttachment(document)).toStrictEqual({
      contentType: "text/html",
      binaryId: "bin-html",
    });
  });

  it("is null when nothing is convertible", () => {
    const document = documentReference([{ contentType: "application/pdf", url: "Binary/bin-pdf" }]);

    expect(pickAttachment(document)).toBeNull();
  });
});

describe("attachmentForBinary", () => {
  it("picks the attachment the Binary id names, not the default choice", () => {
    // RTF comes first, so `pickAttachment` would choose it; a Binary reference to
    // the HTML attachment must still get the HTML one.
    const document = documentReference([
      { contentType: "application/rtf", url: "Binary/bin-rtf" },
      { contentType: "text/html", url: "Binary/bin-html" },
    ]);

    expect(attachmentForBinary(document, "bin-html")).toStrictEqual({
      contentType: "text/html",
      binaryId: "bin-html",
    });
    expect(attachmentForBinary(document, "bin-rtf")).toStrictEqual({
      contentType: "application/rtf",
      binaryId: "bin-rtf",
    });
  });

  it("is null when the named Binary's declared type is not convertible", () => {
    const document = documentReference([{ contentType: "application/pdf", url: "Binary/bin-pdf" }]);

    expect(attachmentForBinary(document, "bin-pdf")).toBeNull();
  });

  it("is null when no attachment names that Binary", () => {
    const document = documentReference([{ contentType: "text/html", url: "Binary/bin-html" }]);

    expect(attachmentForBinary(document, "bin-nope")).toBeNull();
  });
});

describe("decodeBase64Utf8", () => {
  it("round-trips UTF-8, including characters outside ASCII", () => {
    expect(decodeBase64Utf8(b64("Blood pressure 118/74 — normal"))).toBe(
      "Blood pressure 118/74 — normal",
    );
  });

  it("tolerates the line breaks Epic wraps base64 in", () => {
    const wrapped = b64("hello world").replace(/(.{4})/u, "$1\n");

    expect(decodeBase64Utf8(wrapped)).toBe("hello world");
  });

  it("accepts url-safe base64", () => {
    const urlSafe = b64("??>?").replaceAll("+", "-").replaceAll("/", "_");

    expect(decodeBase64Utf8(urlSafe)).toBe("??>?");
  });

  it("throws on something that is not base64 at all", () => {
    expect(() => decodeBase64Utf8("!!!not base64!!!")).toThrow();
  });
});

describe("htmlToText", () => {
  it("turns block ends into newlines and drops the tags", () => {
    const text = htmlToText(
      "<div><h2>Assessment</h2><p>Stable.</p><p>Continue current dose.</p></div>",
    );

    expect(text).toBe("Assessment\nStable.\nContinue current dose.");
  });

  it("turns <br> into a newline", () => {
    expect(htmlToText("one<br>two<br/>three")).toBe("one\ntwo\nthree");
  });

  it("drops script and style contents entirely", () => {
    const text = htmlToText("<style>.x{color:red}</style><p>Visible.</p><script>alert(1)</script>");

    expect(text).toBe("Visible.");
    expect(text).not.toContain("color");
    expect(text).not.toContain("alert");
  });

  it("ends a script block at a closing tag with junk before its >", () => {
    const text = htmlToText("<script>var hidden = 1;</script >Shown.<style>.x{}</style\n>Too.");

    expect(text).toBe("Shown. Too.");
    expect(text).not.toContain("hidden");
  });

  it("does not let stripping one tag join its neighbours into another", () => {
    const text = htmlToText("<scr<b>ipt>alert(1)</scr<b>ipt><p>Visible.</p>");

    expect(text).not.toMatch(/<\/?script/iu);
    expect(text).toContain("Visible.");
  });

  it("decodes the entities a note actually contains, ampersand last", () => {
    expect(htmlToText("<p>A&nbsp;&amp;&nbsp;B &lt;tag&gt; &quot;q&quot; &#39;s&#39;</p>")).toBe(
      "A & B <tag> \"q\" 's'",
    );
    // Decoding & first would turn this into a real tag.
    expect(htmlToText("<p>&amp;lt;b&amp;gt;</p>")).toBe("&lt;b&gt;");
  });

  it("collapses runs of whitespace but keeps paragraph breaks", () => {
    expect(htmlToText("<p>a</p><p></p><p></p><p>b</p>")).toBe("a\n\nb");
  });

  it("survives unbalanced markup rather than throwing", () => {
    expect(htmlToText("<p>text<")).toBe("text<");
  });
});

describe("rtfToText", () => {
  it("extracts the words from a minimal document", () => {
    const rtf = String.raw`{\rtf1\ansi\deff0{\fonttbl{\f0 Courier;}}\f0\fs20 Patient is well.\par Follow up in a year.\par}`;

    expect(rtfToText(rtf)).toBe("Patient is well.\nFollow up in a year.");
  });

  it("drops a `\\*` destination group whole", () => {
    const rtf = String.raw`{\rtf1{\*\generator Some Tool;}Kept.\par}`;

    expect(rtfToText(rtf)).toBe("Kept.");
    expect(rtfToText(rtf)).not.toContain("Some Tool");
  });

  it("decodes a hex escape", () => {
    expect(rtfToText(String.raw`{\rtf1 caf\'e9\par}`)).toBe("café");
  });

  it("turns tabs into tabs", () => {
    expect(rtfToText(String.raw`{\rtf1 a\tab b\par}`)).toContain("\t");
  });
});

describe("convertDocument", () => {
  it("passes plain text through", () => {
    expect(convertDocument("text/plain", "  hello  ")).toBe("hello");
  });

  it("treats a missing content type as plain text", () => {
    expect(convertDocument("", "hello")).toBe("hello");
  });

  it("flattens html and xhtml", () => {
    expect(convertDocument("text/html; charset=utf-8", "<p>hi</p>")).toBe("hi");
    expect(convertDocument("application/xhtml+xml", "<p>hi</p>")).toBe("hi");
  });

  it("flattens rtf under either media type", () => {
    for (const type of ["application/rtf", "text/rtf"]) {
      expect(convertDocument(type, String.raw`{\rtf1 hi\par}`), type).toBe("hi");
    }
  });

  it("refuses what it cannot read, rather than handing over base64 noise", () => {
    for (const type of ["application/pdf", "image/tiff", "application/octet-stream"]) {
      expect(convertDocument(type, "irrelevant"), type).toBeNull();
      expect(isConvertible(type), type).toBe(false);
    }
  });

  it("agrees with isConvertible", () => {
    for (const type of ["text/plain", "text/html", "application/rtf", ""]) {
      expect(isConvertible(type), type).toBe(true);
    }
  });
});
