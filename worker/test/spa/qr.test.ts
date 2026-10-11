// The QR encoder is checked three independent ways, so that a silent encoding
// error cannot pass:
//
//   1. Published vectors: the Reed-Solomon codewords of the well-known
//      "HELLO WORLD" version 1-M example, the format-information table for level
//      M, the version-information words, and the byte capacity of versions.
//   2. Structure: finder, separator, timing and alignment patterns, the dark
//      module, and both copies of the format information, for every mask.
//   3. A reader written here from the specification, not from the encoder: it
//      recovers the mask from the symbol, unmasks, walks the codeword zigzag,
//      de-interleaves, proves every block's Reed-Solomon syndromes are zero and
//      decodes the byte-mode payload back to the original text.

import { describe, expect, it } from "vitest";

import {
  byteCapacity,
  encodeQr,
  formatBits,
  reedSolomonRemainder,
  versionBits,
} from "../../ui/lib/qr.ts";

import type { QrCode } from "../../ui/lib/qr.ts";

// ---------------------------------------------------------------------------
// 1. Published vectors.
// ---------------------------------------------------------------------------

describe("published vectors", () => {
  it("computes the error-correction codewords of the HELLO WORLD 1-M example", () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];

    expect(reedSolomonRemainder(data, 10)).toStrictEqual([
      196, 35, 39, 119, 235, 215, 231, 226, 93, 23,
    ]);
  });

  it("matches the level M row of the format information table", () => {
    const expected = [
      "101010000010010",
      "101000100100101",
      "101111001111100",
      "101101101001011",
      "100010111111001",
      "100000011001110",
      "100111110010111",
      "100101010100000",
    ];

    expect(
      Array.from({ length: 8 }, (_, mask) => formatBits(mask).toString(2).padStart(15, "0")),
    ).toStrictEqual(expected);
  });

  it("matches the published version information words", () => {
    expect(versionBits(7)).toBe(0b00_0111_1100_1001_0100);
    expect(versionBits(8)).toBe(0b00_1000_0101_1011_1100);
  });

  it("has the published byte capacities at level M", () => {
    const capacities = new Map([
      [1, 14],
      [2, 26],
      [3, 42],
      [4, 62],
      [5, 84],
      [10, 213],
      [20, 666],
      [40, 2331],
    ]);

    for (const [version, capacity] of capacities) expect(byteCapacity(version)).toBe(capacity);
  });
});

// ---------------------------------------------------------------------------
// A reader, written from the specification.
// ---------------------------------------------------------------------------

/** Remainder of a polynomial over GF(2), highest bit first. */
function polynomialRemainder(value: number, generator: number, generatorDegree: number): number {
  let remainder = value;
  for (let bit = 31 - Math.clz32(value); bit >= generatorDegree; bit--) {
    if (((remainder >>> bit) & 1) !== 0) remainder ^= generator << (bit - generatorDegree);
  }
  return remainder;
}

function alignmentCentres(version: number): number[] {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const centres = [6];
  let at = size - 7;
  while (centres.length < count) {
    centres.splice(1, 0, at);
    at -= step;
  }
  return centres;
}

/** The alignment patterns' centres, leaving out the three that would overlap a finder. */
function alignmentPatternCentres(version: number): [number, number][] {
  const centres = alignmentCentres(version);
  const last = centres.length - 1;
  const result: [number, number][] = [];
  for (const [i, cx] of centres.entries()) {
    for (const [j, cy] of centres.entries()) {
      const overlapsFinder = (i === 0 && (j === 0 || j === last)) || (i === last && j === 0);
      if (!overlapsFinder) result.push([cx, cy]);
    }
  }
  return result;
}

/** Whether (x, y) belongs to a function pattern, from the layout in the specification. */
function isFunctionModule(version: number, x: number, y: number): boolean {
  const size = version * 4 + 17;
  // Finders with their separators and the format strips beside them, then timing.
  const corners = (x <= 8 && y <= 8) || (x >= size - 8 && y <= 8) || (x <= 8 && y >= size - 8);
  const timing = x === 6 || y === 6;
  const versionBlocks = version >= 7 && ((x >= size - 11 && y <= 5) || (y >= size - 11 && x <= 5));
  return (
    corners ||
    timing ||
    versionBlocks ||
    alignmentPatternCentres(version).some(
      ([cx, cy]) => Math.abs(x - cx) <= 2 && Math.abs(y - cy) <= 2,
    )
  );
}

function bitOf(code: QrCode, x: number, y: number): number {
  return code.modules[y]?.[x] === true ? 1 : 0;
}

/** Both copies of the 15 format bits, read from the symbol. */
function readFormat(code: QrCode): [number, number] {
  const { size } = code;
  let first = 0;
  const firstCells: [number, number][] = [
    ...Array.from({ length: 6 }, (_, i): [number, number] => [8, i]),
    [8, 7],
    [8, 8],
    [7, 8],
    ...Array.from({ length: 6 }, (_, i): [number, number] => [5 - i, 8]),
  ];
  for (const [i, [x, y]] of firstCells.entries()) first |= bitOf(code, x, y) << i;

  let second = 0;
  for (let i = 0; i < 8; i++) second |= bitOf(code, size - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) second |= bitOf(code, 8, size - 15 + i) << i;
  return [first, second];
}

/** Both copies of the 18 version bits, read from the symbol. */
function readVersion(code: QrCode): [number, number] {
  let upper = 0;
  let lower = 0;
  for (let i = 0; i < 18; i++) {
    const a = code.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    upper |= bitOf(code, a, b) << i;
    lower |= bitOf(code, b, a) << i;
  }
  return [upper, lower];
}

// The published per-version block layout at level M (ISO/IEC 18004, table 9).
const BLOCK_COUNT_M = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25,
  26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];
const ECC_LENGTH_M = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];

/** Multiply in GF(256) with the QR reducing polynomial x^8 + x^4 + x^3 + x^2 + 1. */
function multiply(a: number, b: number): number {
  let product = 0;
  for (let bit = 7; bit >= 0; bit--) {
    product = (product << 1) ^ ((product >>> 7) * 0x1_1d);
    product ^= ((b >>> bit) & 1) * a;
  }
  return product;
}

/** Evaluate a codeword polynomial (highest power first) at alpha^power. */
function evaluateAt(codeword: readonly number[], power: number): number {
  let alphaPower = 1;
  for (let i = 0; i < power; i++) alphaPower = multiply(alphaPower, 2);
  let result = 0;
  for (const coefficient of codeword) result = multiply(result, alphaPower) ^ coefficient;
  return result;
}

/** Whether mask `mask` flips the module at (x, y). */
function maskFlips(mask: number, x: number, y: number): boolean {
  return (
    [
      (x + y) % 2 === 0,
      y % 2 === 0,
      x % 3 === 0,
      (x + y) % 3 === 0,
      (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
      ((x * y) % 2) + ((x * y) % 3) === 0,
      (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
      (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
    ].at(mask) === true
  );
}

/** The mask, from the format information; proves both copies agree and form a valid BCH word. */
function readMask(code: QrCode): number {
  const [first, second] = readFormat(code);
  const unmasked = first ^ 0x54_12;
  expect(second).toBe(first);
  expect(polynomialRemainder(unmasked, 0x5_37, 10)).toBe(0);
  expect(unmasked >>> 13).toBe(0); // level M
  return (unmasked >>> 10) & 7;
}

/** Right-hand columns of the column pairs, in reading order. */
function pairColumns(size: number): number[] {
  // (20,19) ... (8,7), then (5,4), (3,2), (1,0): the vertical timing column 6
  // belongs to no pair.
  const rights: number[] = [];
  for (let right = size - 1; right >= 8; right -= 2) rights.push(right);
  return [...rights, 5, 3, 1];
}

/** The modules that carry data, in the order the specification fills them. */
function dataCells(code: QrCode): [number, number][] {
  const cells: [number, number][] = [];
  for (const right of pairColumns(code.size)) {
    const upward = ((right + 1) & 2) === 0;
    for (let step = 0; step < code.size; step++) {
      const y = upward ? code.size - 1 - step : step;
      cells.push([right, y], [right - 1, y]);
    }
  }
  return cells.filter(([x, y]) => !isFunctionModule(code.version, x, y));
}

/** The data bits in the order they sit in the symbol, with the mask undone. */
function readBits(code: QrCode, mask: number): number[] {
  return dataCells(code).map(([x, y]) => bitOf(code, x, y) ^ (maskFlips(mask, x, y) ? 1 : 0));
}

/** The codewords in the order they sit in the symbol. */
function readCodewords(code: QrCode, mask: number): number[] {
  const bits = readBits(code, mask);
  const codewords: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  }
  return codewords;
}

/** Modules the specification sets aside beyond the plain (16v+128)v+64 formula. */
function alignmentModuleCount(version: number): number {
  if (version === 1) return 0;
  const count = Math.floor(version / 7) + 2;
  return (25 * count - 10) * count - 55 + (version >= 7 ? 36 : 0);
}

/** Undo the interleave: one array of data then error-correction codewords per block. */
function deinterleave(codewords: readonly number[], version: number): number[][] {
  const blockCount = BLOCK_COUNT_M.at(version) ?? 0;
  const eccLength = ECC_LENGTH_M.at(version) ?? 0;
  const total = Math.floor(
    ((16 * version + 128) * version + 64 - alignmentModuleCount(version)) / 8,
  );
  const shortBlocks = blockCount - (total % blockCount);
  const shortData = Math.floor(total / blockCount) - eccLength;
  const dataLengths = Array.from({ length: blockCount }, (_, i) =>
    i < shortBlocks ? shortData : shortData + 1,
  );

  const blocks: number[][] = dataLengths.map(() => []);
  let cursor = 0;
  for (let i = 0; i <= shortData; i++) {
    for (const [b, length] of dataLengths.entries()) {
      if (i < length) blocks[b]?.push(codewords[cursor++] ?? 0);
    }
  }
  for (let i = 0; i < eccLength; i++) {
    for (const block of blocks) block.push(codewords[cursor++] ?? 0);
  }
  expect(cursor).toBe(total);
  return blocks;
}

/** Decode a symbol back to text, proving its error-correction codewords on the way. */
function decode(code: QrCode): string {
  const { version } = code;
  const blocks = deinterleave(readCodewords(code, readMask(code)), version);

  // Every block is a Reed-Solomon codeword: its syndromes vanish.
  const eccLength = ECC_LENGTH_M.at(version) ?? 0;
  for (const block of blocks) {
    for (let power = 0; power < eccLength; power++) expect(evaluateAt(block, power)).toBe(0);
  }

  // Byte-mode payload.
  const data = blocks.flatMap((block) => block.slice(0, block.length - eccLength));
  const stream = data.flatMap((byte) =>
    Array.from({ length: 8 }, (_, i) => (byte >>> (7 - i)) & 1),
  );
  const read = (from: number, length: number): number =>
    stream.slice(from, from + length).reduce((value, bit) => (value << 1) | bit, 0);
  expect(read(0, 4)).toBe(0b0100);
  const countLength = version <= 9 ? 8 : 16;
  const count = read(4, countLength);
  const bytes = Uint8Array.from({ length: count }, (_, i) => read(4 + countLength + i * 8, 8));
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// 2 and 3. Structure and round trip.
// ---------------------------------------------------------------------------

/** The three finder patterns' top-left corners. */
function finderOrigins(size: number): [number, number][] {
  return [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ];
}

/** Finder patterns, separators, timing, the dark module and alignment patterns. */
function expectFunctionPatterns(code: QrCode): void {
  const { size, version } = code;
  const dark = (x: number, y: number): boolean => code.modules[y]?.[x] === true;

  // Finders: 7x7 ring, light ring, 3x3 core.
  for (const [ox, oy] of finderOrigins(size)) {
    for (let dy = 0; dy < 7; dy++) {
      for (let dx = 0; dx < 7; dx++) {
        const edge = dx === 0 || dx === 6 || dy === 0 || dy === 6;
        const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
        expect(dark(ox + dx, oy + dy)).toBe(edge || core);
      }
    }
  }

  // Separators: the light row and column around each finder.
  for (let i = 0; i < 8; i++) {
    expect(dark(i, 7)).toBe(false);
    expect(dark(7, i)).toBe(false);
    expect(dark(size - 8, i)).toBe(false);
    expect(dark(size - 1 - i, 7)).toBe(false);
    expect(dark(i, size - 8)).toBe(false);
    expect(dark(7, size - 1 - i)).toBe(false);
  }

  // Timing patterns alternate, starting dark; and the always-dark module.
  for (let i = 8; i < size - 8; i++) {
    expect(dark(i, 6)).toBe(i % 2 === 0);
    expect(dark(6, i)).toBe(i % 2 === 0);
  }
  expect(dark(8, size - 8)).toBe(true);

  // Alignment patterns: 5x5 ring, light inside, dark centre.
  for (const [cx, cy] of alignmentPatternCentres(version)) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        expect(dark(cx + dx, cy + dy)).toBe(Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
}

const SAMPLES = [
  "HELLO WORLD",
  "https://example.test",
  "naïve café ✓",
  // The shape of a pairing string, with synthetic values.
  JSON.stringify({
    v: 1,
    url: "https://healthy.example.test",
    deviceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    token: `hcd1.01ARZ3NDEKTSV4RRFFQ69G5FAV.${"A".repeat(43)}`,
  }),
  // Large enough to need a version with version-information blocks and several
  // alignment patterns, and a mix of block lengths.
  "x".repeat(400),
  "y".repeat(1000),
];

describe("encodeQr", () => {
  it("picks the smallest version that fits", () => {
    expect(encodeQr("a".repeat(14)).version).toBe(1);
    expect(encodeQr("a".repeat(15)).version).toBe(2);
    expect(encodeQr("a".repeat(213)).version).toBe(10);
    expect(encodeQr("a".repeat(214)).version).toBe(11);
    expect(encodeQr("a".repeat(666)).version).toBe(20);
    expect(encodeQr("a".repeat(667)).version).toBe(21);
  });

  it("keeps a pairing string within version 20", () => {
    const pairing = SAMPLES.at(3) ?? "";

    expect(new TextEncoder().encode(pairing).length).toBeLessThan(byteCapacity(20));
    expect(encodeQr(pairing).version).toBeLessThanOrEqual(20);
  });

  it("refuses text that does not fit version 40", () => {
    expect(() => encodeQr("a".repeat(2332))).toThrow(RangeError);
    expect(encodeQr("a".repeat(2331)).version).toBe(40);
  });

  it("is deterministic", () => {
    expect(encodeQr("same input").modules).toStrictEqual(encodeQr("same input").modules);
  });

  describe.each(SAMPLES.map((text) => [String(new TextEncoder().encode(text).length), text]))(
    "%s bytes",
    (_length, text) => {
      it("chooses a mask and decodes back to the text", () => {
        const code = encodeQr(text);

        expect(code.mask).toBeGreaterThanOrEqual(0);
        expect(code.mask).toBeLessThan(8);
        expect(decode(code)).toBe(text);
      });

      it.each([0, 1, 2, 3, 4, 5, 6, 7])("is a valid symbol with mask %i", (mask) => {
        const code = encodeQr(text, { mask });

        expect(code.size).toBe(code.version * 4 + 17);
        expect(code.modules).toHaveLength(code.size);
        expect(code.modules.map((row) => row.length)).toStrictEqual(
          code.modules.map(() => code.size),
        );
        expectFunctionPatterns(code);

        // Format information: both copies, valid BCH, the mask asked for.
        expect(readFormat(code)).toStrictEqual([formatBits(mask), formatBits(mask)]);
        expect(polynomialRemainder(formatBits(mask) ^ 0x54_12, 0x5_37, 10)).toBe(0);

        // Version information (version 7 and up): both blocks, valid BCH.
        const withVersion = code.version >= 7;
        const expectedVersion = versionBits(code.version);
        expect(withVersion ? readVersion(code) : null).toStrictEqual(
          withVersion ? [expectedVersion, expectedVersion] : null,
        );
        expect(withVersion ? polynomialRemainder(expectedVersion, 0x1f_25, 12) : 0).toBe(0);

        // And the whole thing reads back.
        expect(decode(code)).toBe(text);
      });
    },
  );
});
