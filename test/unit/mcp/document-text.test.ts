// Turning an attachment into text. Pure functions, so pure tests.

import { describe, expect, it } from "vitest";

import {
  convertDocument,
  decodeBase64Utf8,
  htmlToText,
  isConvertible,
  rtfToText,
} from "../../../worker/mcp/document-text.ts";

const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");

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
