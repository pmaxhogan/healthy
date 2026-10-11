// A visit's details page, in synthetic markup of the live page's shape: the
// class names and ids are the page's own, every word of text is invented.

import { describe, expect, it } from "vitest";

import { parseVisitDetails } from "../../../../src/ehr/mychart/visit-details.ts";

const WAITLIST_OFFERED = `<div class="visitactions"><div class="waitlist"><div class="waitlisttext" aria-live="polite">
<span id="waitlistpretext" class="waitlistpretext">Want an earlier visit?</span>
<div class="updatewaitlistlink"><a id="updatewaitlist" class="link" href="#" data-add="1">Opt in</a></div>
<span id="waitlistpretext-disabled" class="hidden">You are on the list.</span></div></div></div>`;

const DIRECTIONS = `<h2 class="medium header">Directions for Example Clinic</h2><div class="departmentdirections"><div class="visitinformation visitinstructionscontent"><div><div class="instructionContent" tabindex="-1">
    Check in online before you arrive.<br><br>Tower A, suite 2 &amp; the blue door.<br><br>Payment is due at the visit.
  </div></div><div class="readmore hidden"><a class="button autowidth" href="#">View full directions</a></div></div></div>`;

const INSTRUCTIONS = `<h2 class="medium header">Visit Instructions</h2><div class="visitinformation"><div class="visitinformation visitinstructionscontent"><div><div class="instructionContent"><div class="fmtConv"><style>.p0 { margin: 0 }</style><div class="p0"><span>Bring your cards.</span></div><div class="p0"><span></span></div><div class="p0"><span>Arrive early.</span></div></div></div></div><div class="readmore hidden"><a class="button autowidth" href="#">More</a></div></div></div>`;

function page(...parts: string[]): string {
  return `<html><body><main><h2 class="header large">Office Visit</h2>${parts.join("")}</main></body></html>`;
}

describe("parseVisitDetails", () => {
  it("reads directions and instructions as paragraphs of plain text", () => {
    const details = parseVisitDetails(page(DIRECTIONS, INSTRUCTIONS));

    expect(details.directions).toBe(
      "Check in online before you arrive.\n\nTower A, suite 2 & the blue door.\n\nPayment is due at the visit.",
    );
    expect(details.visitInstructions).toBe("Bring your cards.\n\nArrive early.");
  });

  it("reads a wait list the visit offers, and whether the patient is on it", () => {
    expect(parseVisitDetails(page(WAITLIST_OFFERED)).waitlist).toStrictEqual({ enrolled: false });
    const enrolled = page(WAITLIST_OFFERED.replace('data-add="1"', 'data-add="0"'));
    expect(parseVisitDetails(enrolled).waitlist).toStrictEqual({ enrolled: true });
    const unreadable = page(WAITLIST_OFFERED.replace(' data-add="1"', ""));
    expect(parseVisitDetails(unreadable).waitlist).toStrictEqual({ enrolled: null });
  });

  it("says a page with no wait list block offers none", () => {
    expect(parseVisitDetails(page(DIRECTIONS)).waitlist).toBeNull();
  });

  it("does not mistake the directions for instructions, or the other way round", () => {
    expect(parseVisitDetails(page(DIRECTIONS)).visitInstructions).toBeUndefined();
    expect(parseVisitDetails(page(INSTRUCTIONS)).directions).toBeUndefined();
  });

  it("returns nothing but the wait list for an empty page", () => {
    expect(parseVisitDetails("")).toStrictEqual({ waitlist: null });
  });
});
