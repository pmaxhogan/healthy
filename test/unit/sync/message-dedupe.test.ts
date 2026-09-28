// Which copies of a secure message are the same message, and which one speaks.
//
// The rule is identity only: the same content digest from two health systems.
// Everything nearby -- the same second with different text, the same text a
// second apart -- is two messages, because a time-only match is the regression
// the visits' dedupe once had (an Encounter adopting a visit it only shared a
// clock with).

import { describe, expect, it } from "vitest";

import {
  collapseMessages,
  messageRank,
  sameMessageAcrossHealthSystems,
} from "../../../worker/sync/message-dedupe.ts";
import { STALE_SECONDS } from "../../../worker/sync/portal-dedupe.ts";

import type { MessageSighting } from "../../../worker/sync/message-dedupe.ts";

const NOW = 1_780_272_000;
const A = "hs_a";
const B = "hs_b";

function sighting(
  healthSystemId: string,
  fingerprint: string,
  external: boolean,
  lastReadAt: number | null = NOW,
): { sighting: MessageSighting; label: string } {
  return {
    sighting: { healthSystemId, fingerprint, rank: messageRank(external, lastReadAt, NOW) },
    label: `${healthSystemId}:${fingerprint}:${external ? "external" : "first"}`,
  };
}

describe("sameMessageAcrossHealthSystems", () => {
  it("matches the same content from two health systems", () => {
    expect(
      sameMessageAcrossHealthSystems(
        sighting(A, "fp-1", false).sighting,
        sighting(B, "fp-1", true).sighting,
      ),
    ).toBe(true);
  });

  it("never matches two copies in one health system", () => {
    expect(
      sameMessageAcrossHealthSystems(
        sighting(A, "fp-1", false).sighting,
        sighting(A, "fp-1", true).sighting,
      ),
    ).toBe(false);
  });

  it("does not match near-duplicates: a different digest is a different message", () => {
    // The digests of "same second, other text" and "same text, next second".
    expect(
      sameMessageAcrossHealthSystems(
        sighting(A, "fp-same-second-text-1", false).sighting,
        sighting(B, "fp-same-second-text-2", true).sighting,
      ),
    ).toBe(false);
  });
});

describe("collapseMessages", () => {
  it("answers a message both portals show once, from its own health system", () => {
    const kept = collapseMessages([sighting(A, "fp-1", true), sighting(B, "fp-1", false)]);

    expect(kept.map((entry) => entry.label)).toStrictEqual(["hs_b:fp-1:first"]);
  });

  it("keeps a message only one portal shows, even second-hand", () => {
    const kept = collapseMessages([
      sighting(A, "fp-notice", false),
      sighting(B, "fp-elsewhere", true),
    ]);

    expect(kept.map((entry) => entry.label).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
      "hs_a:fp-notice:first",
      "hs_b:fp-elsewhere:external",
    ]);
  });

  it("keeps two second-hand copies to one when no first-party copy exists", () => {
    const kept = collapseMessages([sighting(B, "fp-2", true), sighting(A, "fp-2", true)]);

    // A tie goes to the lower health system id, whichever order they came in.
    expect(kept.map((entry) => entry.label)).toStrictEqual(["hs_a:fp-2:external"]);
  });

  it("lets a fresh second-hand copy speak for a first-party one whose portal went quiet", () => {
    const kept = collapseMessages([
      sighting(A, "fp-3", false, NOW - STALE_SECONDS - 1),
      sighting(B, "fp-3", true),
    ]);

    expect(kept.map((entry) => entry.label)).toStrictEqual(["hs_b:fp-3:external"]);
  });

  it("keeps a portal's own two identical messages: it is two messages there", () => {
    const kept = collapseMessages([sighting(A, "fp-4", false), sighting(A, "fp-4", false)]);

    expect(kept).toHaveLength(2);
  });
});
