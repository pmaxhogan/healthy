import { describe, expect, it } from "vitest";

import { AppError } from "../../../worker/lib/errors.ts";
import { ID_PATTERN, idTimeMs, newId } from "../../../worker/lib/ids.ts";

describe("newId", () => {
  it("is 26 characters of Crockford base32", () => {
    const id = newId();

    expect(id).toHaveLength(26);
    expect(id).toMatch(ID_PATTERN);
    // No I, L, O or U: an id cannot be misread and cannot spell a word.
    expect(id).not.toMatch(/[ILOU]/u);
  });

  it("never repeats across a large batch", () => {
    const ids = Array.from({ length: 5000 }, () => newId());

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("sorts lexicographically in time order", () => {
    const early = newId(1_700_000_000_000);
    const later = newId(1_700_000_001_000);
    const muchLater = newId(1_900_000_000_000);

    expect([muchLater, early, later].toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
      early,
      later,
      muchLater,
    ]);
  });

  it("shares its time prefix with every id minted in the same millisecond", () => {
    const at = 1_700_000_000_000;

    expect(newId(at).slice(0, 10)).toBe(newId(at).slice(0, 10));
    // ...and differs in the random half, so the prefix is not the whole id.
    expect(newId(at)).not.toBe(newId(at));
  });

  it("refuses a timestamp it cannot encode", () => {
    expect(() => newId(-1)).toThrow(AppError);
    expect(() => newId(1.5)).toThrow(/out of range/);
    expect(() => newId(2 ** 48)).toThrow(AppError);
  });
});

describe("idTimeMs", () => {
  it("recovers the millisecond the id was minted at", () => {
    expect(idTimeMs(newId(1_767_225_600_123))).toBe(1_767_225_600_123);
    expect(idTimeMs(newId(0))).toBe(0);
  });

  it("rejects anything that is not one of our ids", () => {
    expect(() => idTimeMs("too-short")).toThrow(AppError);
    // Lower case and the excluded letters are both out.
    expect(() => idTimeMs(newId().toLowerCase())).toThrow(/sortable id/);
  });
});
