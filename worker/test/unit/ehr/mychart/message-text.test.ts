// A message body flattened to text: what a reader sees and nothing else.

import { describe, expect, it } from "vitest";

import { messageText } from "../../../../src/ehr/mychart/message-text.ts";

describe("messageText", () => {
  it("drops style, script and comments with their content", () => {
    expect(
      messageText(
        '<style nonce="a">.x{color:red}</style ><script>alert(1)</script><!-- note -->Hello',
      ),
    ).toBe("Hello");
  });

  it("decodes named and numeric entities once, never twice", () => {
    expect(messageText("a &amp;lt; b &#8217;s &#x2014; &nbsp;c &bogus; &#0;")).toBe(
      "a &lt; b ’s — c &bogus; &#0;",
    );
  });

  it("does not let a split tag reassemble into markup", () => {
    expect(messageText("<scr<b>ipt>x</scr</b>ipt>")).not.toContain("<");
  });

  it("keeps paragraphs apart and collapses runs of blank lines", () => {
    expect(messageText("<p>One</p><p></p><p></p><div>Two<br>Three</div>")).toBe(
      "One\n\nTwo\nThree",
    );
  });

  it("reads the invalid closing </br> as a line break, as browsers do", () => {
    expect(messageText("One.</br></br>Two.</br>Three.")).toBe("One.\n\nTwo.\nThree.");
  });

  it("keeps table cells apart", () => {
    expect(messageText("<table><tr><td>Sodium</td><td>140</td></tr></table>")).toBe("Sodium 140");
  });
});
