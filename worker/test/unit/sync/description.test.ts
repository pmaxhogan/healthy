// The owner and Healthy share one description field. These pin the contract:
// the owner's text above the rule is never touched, Healthy's block below it is
// always current, and nothing is written twice. Every value here is invented.

import { describe, expect, it } from "vitest";

import {
  carriesBlock,
  healthyBlock,
  linkify,
  mergeDescription,
} from "../../../src/sync/description.ts";

const DETAILS = "Example Clinic\n1 Test Way & Annex, Testville\n\nCasey Example — Cardiology";
const BLOCK = healthyBlock(DETAILS);
const NEWER = healthyBlock(DETAILS.replace("Cardiology", "Neurology"));
const PORTAL = "https://portal.example.test/mychart";
const LINK = linkify("Office Visit · confirmed", PORTAL);
const LINKED_DETAILS = `${DETAILS}\n${LINK}`;
const LINKED_BLOCK = healthyBlock(LINKED_DETAILS);
/** What the pre-rule format wrote. */
const LEGACY = `${DETAILS}\n\nSynced by Healthy · do not edit`;
const LEGACY_GHOST = `${LEGACY}\n\nNo longer on the health system's schedule as of Oct 1, 2026.`;

describe("healthyBlock", () => {
  it("begins with the rule, then the header, then the details", () => {
    expect(BLOCK).toBe(`-------\nSynced by Healthy · do not edit below the line\n${DETAILS}`);
  });
});

describe("mergeDescription", () => {
  it("writes the bare block when there is nothing yet", () => {
    expect(mergeDescription(null, BLOCK)).toBe(BLOCK);
    expect(mergeDescription("", BLOCK)).toBe(BLOCK);
    expect(mergeDescription("  \n", BLOCK)).toBe(BLOCK);
  });

  it("keeps the owner's text above the rule verbatim and replaces what is below", () => {
    const owner = "Bring the referral.\n  Parking: level 3  \n\n";

    expect(mergeDescription(`${owner}${BLOCK}`, NEWER)).toBe(`${owner}${NEWER}`);
  });

  it("overwrites anything the owner typed below the rule", () => {
    const edited = `Note\n${BLOCK}\nMy own line below the rule`;

    expect(mergeDescription(edited, BLOCK)).toBe(`Note\n${BLOCK}`);
  });

  it("uses the first rule line, and only a line that is exactly the rule", () => {
    const owner = "Checklist ------- not a rule\n--------\n-------x\n";
    const current = `${owner}${BLOCK}\n-------\nstale`;

    expect(mergeDescription(current, NEWER)).toBe(`${owner}${NEWER}`);
  });

  it("appends the block after arbitrary text that has no rule", () => {
    expect(mergeDescription("Owner wrote this", BLOCK)).toBe(`Owner wrote this\n\n${BLOCK}`);
    expect(mergeDescription("Ends in a newline\n", BLOCK)).toBe(`Ends in a newline\n${BLOCK}`);
  });

  it("replaces a legacy description wholesale rather than duplicating it", () => {
    expect(mergeDescription(LEGACY, BLOCK)).toBe(BLOCK);
    expect(mergeDescription(LEGACY_GHOST, BLOCK)).toBe(BLOCK);
  });

  it("keeps a note appended after a legacy description, above the rule", () => {
    expect(mergeDescription(`${LEGACY}\n\nOwner's note`, BLOCK)).toBe(`Owner's note\n\n${BLOCK}`);
    expect(mergeDescription(`${LEGACY_GHOST}\nOwner's note\nsecond line`, BLOCK)).toBe(
      `Owner's note\nsecond line\n\n${BLOCK}`,
    );
  });

  it("keeps the owner's HTML verbatim and writes the block as HTML to match", () => {
    const owner = "<b>Fasting</b> from midnight<br><br>";
    const google = `${owner}-------<br>Synced by Healthy · do not edit below the line<br>stale`;

    const merged = mergeDescription(google, BLOCK);

    expect(merged.startsWith(owner)).toBe(true);
    expect(merged.slice(owner.length)).toBe(
      "-------<br>Synced by Healthy · do not edit below the line<br>Example Clinic<br>" +
        "1 Test Way &amp; Annex, Testville<br><br>Casey Example — Cardiology",
    );
    expect(carriesBlock(merged, BLOCK)).toBe(true);
  });

  it("finds a rule wrapped in a div and cuts before the opening tag", () => {
    const owner = "<div>Owner note</div>";
    const google = `${owner}<div>-------</div><div>old details</div>`;

    const merged = mergeDescription(google, BLOCK);

    expect(merged.startsWith(`${owner}-------<br>`)).toBe(true);
    expect(carriesBlock(merged, BLOCK)).toBe(true);
  });

  it("recognises a rule between self-closing breaks and non-breaking spaces", () => {
    const google = "Owner<br/>&nbsp;-------&nbsp;<br />old";

    expect(mergeDescription(google, BLOCK).startsWith("Owner<br/>-------<br>")).toBe(true);
  });

  it("appends to HTML with no rule using HTML breaks", () => {
    expect(
      mergeDescription("<i>Owner</i>", BLOCK).startsWith("<i>Owner</i><br><br>-------<br>"),
    ).toBe(true);
  });

  it("migrates a legacy description Google has turned into HTML", () => {
    const html = `${LEGACY.replaceAll("\n", "<br>")}<br><br>Owner's note`;

    // The old rendering goes, markup and all; the note after it is plain text, so
    // the block that follows it is too.
    expect(mergeDescription(html, BLOCK)).toBe(`Owner's note\n\n${BLOCK}`);
  });

  it("is idempotent: merging its own output changes nothing", () => {
    for (const current of [
      null,
      "Owner wrote this",
      `Note\n\n${BLOCK}`,
      LEGACY,
      `${LEGACY_GHOST}\n\nOwner's note`,
      "<b>Owner</b><br>-------<br>stale",
    ]) {
      const once = mergeDescription(current, BLOCK);
      expect(carriesBlock(once, BLOCK)).toBe(true);
      expect(mergeDescription(once, BLOCK)).toBe(once);
    }
  });

  it("is idempotent for a block that carries a link too", () => {
    for (const current of [null, "Owner wrote this", "<b>Owner</b><br>-------<br>stale"]) {
      const once = mergeDescription(current, LINKED_BLOCK);
      expect(carriesBlock(once, LINKED_BLOCK)).toBe(true);
      expect(mergeDescription(once, LINKED_BLOCK)).toBe(once);
    }
  });
});

describe("linkify", () => {
  it("wraps the text in an anchor to the url", () => {
    expect(linkify("Office Visit · confirmed", PORTAL)).toBe(
      `<a href="${PORTAL}">Office Visit · confirmed</a>`,
    );
  });

  it("escapes an ampersand and a quote in the url, and entities in the text", () => {
    expect(linkify("A & B", 'https://portal.example.test/v?a=1&b="x"')).toBe(
      '<a href="https://portal.example.test/v?a=1&amp;b=&quot;x&quot;">A &amp; B</a>',
    );
  });
});

describe("a link inside the block", () => {
  it("stays a real anchor under plain owner text, alongside literal & and <", () => {
    // The owner's plain text is carried over as HTML that renders the same, so a
    // raw "&"/"<" still shows as a literal character next to a working link.
    const owner = "Bring card & ID <3\n\n";

    const merged = mergeDescription(`${owner}${LINKED_BLOCK}`, LINKED_BLOCK);

    expect(merged.startsWith("Bring card &amp; ID &lt;3<br><br>-------<br>")).toBe(true);
    expect(merged).toContain(LINK);
    expect(carriesBlock(merged, LINKED_BLOCK)).toBe(true);
  });

  it("is written as HTML throughout, with no bare newline a strict client would collapse", () => {
    // Business Calendar renders a description holding any markup as HTML, where
    // "\n" is just a space: a linked block joined with "\n" showed on one line.
    for (const current of [null, "Owner wrote this", "Line one\nLine two\n", `Note\n${BLOCK}`]) {
      const merged = mergeDescription(current, LINKED_BLOCK);
      expect(merged).not.toContain("\n");
      expect(merged).toContain("-------<br>Synced by Healthy · do not edit below the line<br>");
      expect(merged).toContain(LINK);
    }
    expect(
      mergeDescription("Line one\nLine two\n", LINKED_BLOCK).startsWith(
        "Line one<br>Line two<br>-------<br>",
      ),
    ).toBe(true);
  });

  it("rewrites a linked description written the old way, once", () => {
    // What every linked event carried before: the block joined with "\n".
    const old = LINKED_BLOCK;
    const oldUnderNote = `Note\n\n${LINKED_BLOCK}`;

    for (const current of [old, oldUnderNote]) {
      expect(carriesBlock(current, LINKED_BLOCK)).toBe(false);
      const fixed = mergeDescription(current, LINKED_BLOCK);
      expect(carriesBlock(fixed, LINKED_BLOCK)).toBe(true);
      expect(mergeDescription(fixed, LINKED_BLOCK)).toBe(fixed);
    }
  });

  it("leaves a block with no link as plain text", () => {
    expect(mergeDescription(null, BLOCK)).toBe(BLOCK);
    expect(carriesBlock(BLOCK, BLOCK)).toBe(true);
  });

  it("survives escaping when the owner's part is HTML, instead of becoming visible markup", () => {
    const owner = "<b>Fasting</b> from midnight<br><br>";
    const google = `${owner}-------<br>Synced by Healthy · do not edit below the line<br>stale`;

    const merged = mergeDescription(google, LINKED_BLOCK);

    expect(merged).toBe(
      `${owner}-------<br>Synced by Healthy · do not edit below the line<br>` +
        `Example Clinic<br>1 Test Way &amp; Annex, Testville<br><br>Casey Example — Cardiology<br>` +
        LINK,
    );
    expect(carriesBlock(merged, LINKED_BLOCK)).toBe(true);
  });

  it('still reads as settled after Google\'s editor adds target="_blank" and un-escapes the href', () => {
    // Observed live (2026-09-28): saving any edit through Google's web editor --
    // even to text that has nothing to do with the link -- rewrites our anchor to
    // add this attribute and turns a pre-escaped "&amp;" in the href back into a
    // raw "&". Neither changes the link's visible text, so it must not read as a
    // change and force a patch every time the owner touches their own note.
    const linkWithQuery = linkify(
      "Office Visit · confirmed",
      "https://portal.example.test/mychart?a=1&b=2",
    );
    const block = healthyBlock(`Example Clinic\n${linkWithQuery}`);
    const saved =
      "Bring card &amp; ID<br>-------<br>Synced by Healthy · do not edit below the line<br>" +
      'Example Clinic<br><a href="https://portal.example.test/mychart?a=1&b=2" target="_blank">' +
      "Office Visit · confirmed</a>";

    expect(carriesBlock(saved, block)).toBe(true);
  });
});

describe("what Google's web editor really stores", () => {
  // The shape Google Calendar saved after the owner bolded a line of their own
  // above the rule on a rehearsal event: the WHOLE description turns into HTML,
  // `&` becomes `&amp;`, and the bold wraps a trailing <br>. Content is synthetic.
  const saved =
    "<b>Owner note: bring the referral &amp; ID<br></b><br>-------<br>" +
    "Synced by Healthy · do not edit below the line<br>Example Clinic<br>" +
    "1 Test Way &amp; Annex, Testville<br><br>Casey Example — Cardiology";

  it("still reads as settled, so the edit costs no write", () => {
    expect(carriesBlock(saved, BLOCK)).toBe(true);
    expect(mergeDescription(saved, BLOCK)).toBe(saved);
  });

  it("keeps the owner's markup and writes a changed block as matching HTML", () => {
    const merged = mergeDescription(saved, NEWER);

    expect(
      merged.startsWith("<b>Owner note: bring the referral &amp; ID<br></b><br>-------<br>"),
    ).toBe(true);
    expect(merged.endsWith("Casey Example — Neurology")).toBe(true);
    expect(carriesBlock(merged, NEWER)).toBe(true);
  });
});

describe("carriesBlock", () => {
  it("is true whatever the owner wrote above the rule", () => {
    expect(carriesBlock(BLOCK, BLOCK)).toBe(true);
    expect(carriesBlock(`Anything at all\n\n${BLOCK}`, BLOCK)).toBe(true);
  });

  it("is false with no rule, no description, a legacy one, or a stale block", () => {
    expect(carriesBlock(null, BLOCK)).toBe(false);
    expect(carriesBlock("Owner only", BLOCK)).toBe(false);
    expect(carriesBlock(LEGACY, BLOCK)).toBe(false);
    expect(carriesBlock(BLOCK, NEWER)).toBe(false);
    expect(carriesBlock(`${BLOCK}\nextra`, BLOCK)).toBe(false);
  });

  it("ignores Google's HTML re-encoding and blank-line changes", () => {
    const reencoded = `Note<br>${BLOCK.replaceAll("&", "&amp;").replaceAll("\n", "<br>")}`;
    const reflowed = BLOCK.replaceAll("\n\n", "\n");
    const linked = BLOCK.replace("Example Clinic", '<a href="x">Example Clinic</a>');

    expect(carriesBlock(reencoded, BLOCK)).toBe(true);
    expect(carriesBlock(`<p>Note</p>${reflowed}`, BLOCK)).toBe(true);
    expect(carriesBlock(linked, BLOCK)).toBe(true);
  });
});
