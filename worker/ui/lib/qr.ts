// A small, dependency-free QR Code encoder: byte mode, error correction level M,
// the smallest version that fits (1 to 40), all eight masks scored by the
// specification's penalty rules.
//
// It exists for one job -- drawing the pairing code on the Phone page -- so it
// does exactly that and no more: no other modes, no other levels, no ECI. The
// text is encoded as UTF-8 bytes, which every scanner reads.
//
// Structure follows ISO/IEC 18004: build the data bit stream, split it into
// Reed-Solomon blocks and interleave them, draw the function patterns, place the
// codewords in the zigzag, then try every mask and keep the lowest penalty.
//
// Pure: no DOM, no Vue. `worker/ui/components/QrCode.vue` draws the result.

/** Dark modules are `true`. Row-major: `modules[y][x]`. */
export interface QrCode {
  version: number;
  /** Modules per side: `4 * version + 17`. */
  size: number;
  mask: number;
  modules: boolean[][];
}

const MIN_VERSION = 1;
const MAX_VERSION = 40;
const MASK_COUNT = 8;

/** Error-correction codewords per block at level M, indexed by version (index 0 unused). */
const ECC_CODEWORDS_PER_BLOCK = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];

/** Error-correction blocks at level M, indexed by version (index 0 unused). */
const ERROR_CORRECTION_BLOCKS = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25,
  26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];

/** Level M's two-bit code in the format information. */
const ECL_M_FORMAT_BITS = 0;

/** Padding codewords that fill a data stream to capacity, alternating. */
const PAD_BYTES = [0xec, 0x11] as const;

/** Penalty weights, from the specification. */
const PENALTY_RUN = 3;
const PENALTY_BLOCK = 3;
const PENALTY_FINDER = 40;
const PENALTY_BALANCE = 10;

function tableAt(table: readonly number[], version: number): number {
  const value = table[version];
  if (value === undefined) throw new RangeError(`no QR table entry for version ${String(version)}`);
  return value;
}

/** Modules in a version's symbol that can carry data or error correction (not function patterns). */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignCount = Math.floor(version / 7) + 2;
    result -= (25 * alignCount - 10) * alignCount - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Data codewords (not error correction) a version holds at level M. */
function dataCodewords(version: number): number {
  return (
    Math.floor(rawDataModules(version) / 8) -
    tableAt(ECC_CODEWORDS_PER_BLOCK, version) * tableAt(ERROR_CORRECTION_BLOCKS, version)
  );
}

/** Bits of the character-count field in byte mode. */
function countBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/** The most bytes a version carries in byte mode at level M. */
export function byteCapacity(version: number): number {
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits(version)) / 8);
}

// ---------------------------------------------------------------------------
// Reed-Solomon over GF(256), reducing polynomial x^8 + x^4 + x^3 + x^2 + 1.
// ---------------------------------------------------------------------------

function gfMultiply(a: number, b: number): number {
  let product = 0;
  for (let bit = 7; bit >= 0; bit--) {
    product = (product << 1) ^ ((product >>> 7) * 0x1_1d);
    product ^= ((b >>> bit) & 1) * a;
  }
  return product;
}

function generatorPolynomial(degree: number): number[] {
  // Coefficients without the leading 1, highest power first, of the product of
  // (x - 2^i) for i in 0 to degree - 1.
  const result: number[] = Array.from({ length: degree }, () => 0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j] ?? 0, root) ^ (result[j + 1] ?? 0);
    }
    root = gfMultiply(root, 2);
  }
  return result;
}

/** The error-correction codewords of `data`: its remainder on division by the generator. */
export function reedSolomonRemainder(data: readonly number[], degree: number): number[] {
  const generator = generatorPolynomial(degree);
  const result: number[] = Array.from({ length: degree }, () => 0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() ?? 0);
    result.push(0);
    for (const [i, coefficient] of generator.entries()) {
      result[i] = (result[i] ?? 0) ^ gfMultiply(coefficient, factor);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Data stream.
// ---------------------------------------------------------------------------

function appendBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

/** Mode, count, bytes, terminator and padding: exactly `dataCodewords(version)` bytes. */
function dataStream(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, countBits(version));
  for (const byte of bytes) appendBits(bits, byte, 8);

  const capacityBits = dataCodewords(version) * 8;
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] ?? 0);
    codewords.push(byte);
  }
  const padCount = dataCodewords(version) - codewords.length;
  for (let i = 0; i < padCount; i++) codewords.push(PAD_BYTES[i % 2] ?? 0);
  return codewords;
}

/** Split into blocks, add each block's error correction, and interleave. */
function interleave(data: readonly number[], version: number): number[] {
  const blockCount = tableAt(ERROR_CORRECTION_BLOCKS, version);
  const eccLength = tableAt(ECC_CODEWORDS_PER_BLOCK, version);
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blockCount - (rawCodewords % blockCount);
  const shortLength = Math.floor(rawCodewords / blockCount);

  const blocks: number[][] = [];
  const eccBlocks: number[][] = [];
  let offset = 0;
  for (let i = 0; i < blockCount; i++) {
    const length = shortLength - eccLength + (i < shortBlocks ? 0 : 1);
    const block = data.slice(offset, offset + length);
    offset += length;
    blocks.push(block);
    eccBlocks.push(reedSolomonRemainder(block, eccLength));
  }

  const result: number[] = [];
  const longest = shortLength - eccLength + 1;
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) {
      const value = block[i];
      if (value !== undefined) result.push(value);
    }
  }
  for (let i = 0; i < eccLength; i++) {
    for (const block of eccBlocks) result.push(block[i] ?? 0);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Format and version information (BCH codes).
// ---------------------------------------------------------------------------

/** The 15 format bits for level M and a mask, masked with 0x5412. */
export function formatBits(mask: number): number {
  const data = (ECL_M_FORMAT_BITS << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x5_37);
  return ((data << 10) | remainder) ^ 0x54_12;
}

/** The 18 version bits, for versions 7 and up. */
export function versionBits(version: number): number {
  let remainder = version;
  for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f_25);
  return (version << 12) | remainder;
}

// ---------------------------------------------------------------------------
// The symbol.
// ---------------------------------------------------------------------------

function bitAt(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0;
}

class QrSymbol {
  private readonly isFunction: boolean[][];
  readonly size: number;
  readonly modules: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () =>
      Array.from({ length: this.size }, () => false),
    );
    this.isFunction = Array.from({ length: this.size }, () =>
      Array.from({ length: this.size }, () => false),
    );
    this.drawFunctionPatterns();
  }

  private setFunction(x: number, y: number, dark: boolean): void {
    const row = this.modules[y];
    const flags = this.isFunction[y];
    if (row === undefined || flags === undefined) return;
    row[x] = dark;
    flags[x] = true;
  }

  private alignmentPositions(): number[] {
    if (this.version === 1) return [];
    const count = Math.floor(this.version / 7) + 2;
    const step = this.version === 32 ? 26 : Math.ceil((this.version * 4 + 4) / (count * 2 - 2)) * 2;
    // The first centre is always 6, the last is 7 in from the far edge, and the
    // rest step back from the last at a fixed interval.
    const inner = Array.from(
      { length: count - 1 },
      (_, i) => this.size - 7 - (count - 2 - i) * step,
    );
    return [6, ...inner];
  }

  private drawFinder(centreX: number, centreY: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const x = centreX + dx;
        const y = centreY + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
          this.setFunction(x, y, distance !== 2 && distance !== 4);
        }
      }
    }
  }

  private drawAlignment(centreX: number, centreY: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunction(centreX + dx, centreY + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  private drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);

    const positions = this.alignmentPositions();
    const last = positions.length - 1;
    for (const [i, x] of positions.entries()) {
      for (const [j, y] of positions.entries()) {
        // The three corners where a finder already sits.
        if ((i === 0 && (j === 0 || j === last)) || (i === last && j === 0)) continue;
        this.drawAlignment(x, y);
      }
    }

    // Reserve the format area now (any value) so data placement skips it; the
    // real bits are drawn once the mask is chosen.
    this.drawFormat(0);
    this.drawVersion();
  }

  private drawVersion(): void {
    if (this.version < 7) return;
    const bits = versionBits(this.version);
    for (let i = 0; i < 18; i++) {
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, bitAt(bits, i));
      this.setFunction(b, a, bitAt(bits, i));
    }
  }

  /**
   * Every module that carries data, in the order the specification fills them:
   * column pairs from the right, alternately upward and downward, the vertical
   * timing column skipped, function modules passed over.
   */
  private dataPositions(): [number, number][] {
    const rights: number[] = [];
    for (let right = this.size - 1; right >= 8; right -= 2) rights.push(right);
    rights.push(5, 3, 1);

    const positions: [number, number][] = [];
    for (const right of rights) {
      const upward = ((right + 1) & 2) === 0;
      for (let step = 0; step < this.size; step++) {
        const y = upward ? this.size - 1 - step : step;
        for (const x of [right, right - 1]) {
          if (this.isFunction[y]?.[x] === false) positions.push([x, y]);
        }
      }
    }
    return positions;
  }

  /** Both copies of the format information, and the always-dark module. */
  drawFormat(mask: number): void {
    const bits = formatBits(mask);
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bitAt(bits, i));
    this.setFunction(8, 7, bitAt(bits, 6));
    this.setFunction(8, 8, bitAt(bits, 7));
    this.setFunction(7, 8, bitAt(bits, 8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bitAt(bits, i));

    for (let i = 0; i < 8; i++) this.setFunction(this.size - 1 - i, 8, bitAt(bits, i));
    for (let i = 8; i < 15; i++) this.setFunction(8, this.size - 15 + i, bitAt(bits, i));
    this.setFunction(8, this.size - 8, true);
  }

  /** The codeword bits, most significant first, in the specification's zigzag. */
  placeCodewords(codewords: readonly number[]): void {
    for (const [index, [x, y]] of this.dataPositions().entries()) {
      // Past the last codeword are the version's remainder bits: light.
      const byte = codewords[index >>> 3] ?? 0;
      const row = this.modules[y];
      if (row !== undefined) row[x] = index < codewords.length * 8 && bitAt(byte, 7 - (index & 7));
    }
  }

  /** Flip every data module the mask selects. Applying it twice undoes it. */
  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        const row = this.modules[y];
        if (row !== undefined && this.isFunction[y]?.[x] === false && maskSelects(mask, x, y)) {
          row[x] = row[x] !== true;
        }
      }
    }
  }
}

function maskSelects(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: {
      return (x + y) % 2 === 0;
    }
    case 1: {
      return y % 2 === 0;
    }
    case 2: {
      return x % 3 === 0;
    }
    case 3: {
      return (x + y) % 3 === 0;
    }
    case 4: {
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    }
    case 5: {
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    }
    case 6: {
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
    default: {
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Mask scoring.
// ---------------------------------------------------------------------------

/** Penalty for runs of five or more same-coloured modules in one line. */
function runPenalty(line: readonly boolean[]): number {
  let penalty = 0;
  let run = 1;
  for (let i = 1; i < line.length; i++) {
    if (line[i] === line[i - 1]) {
      run++;
      if (run === 5) penalty += PENALTY_RUN;
      else if (run > 5) penalty++;
    } else {
      run = 1;
    }
  }
  return penalty;
}

/** 1:1:3:1:1 finder-like patterns with four light modules on one side. */
const FINDER_LIKE = [
  [true, false, true, true, true, false, true, false, false, false, false],
  [false, false, false, false, true, false, true, true, true, false, true],
] as const;

function finderPenalty(line: readonly boolean[]): number {
  let penalty = 0;
  for (let start = 0; start + 11 <= line.length; start++) {
    for (const pattern of FINDER_LIKE) {
      if (pattern.every((dark, offset) => line[start + offset] === dark)) {
        penalty += PENALTY_FINDER;
      }
    }
  }
  return penalty;
}

function penaltyScore(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length;
  let penalty = 0;

  for (let y = 0; y < size; y++) {
    const row = modules[y] ?? [];
    const column = modules.map((r) => r[y] ?? false);
    penalty += runPenalty(row) + runPenalty(column);
    penalty += finderPenalty(row) + finderPenalty(column);
  }

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const colour = modules[y]?.[x];
      if (
        colour === modules[y]?.[x + 1] &&
        colour === modules[y + 1]?.[x] &&
        colour === modules[y + 1]?.[x + 1]
      ) {
        penalty += PENALTY_BLOCK;
      }
    }
  }

  let dark = 0;
  for (const row of modules) for (const module of row) if (module) dark++;
  const total = size * size;
  // How many whole 5% steps the dark share is from half.
  const steps = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  penalty += Math.max(0, steps) * PENALTY_BALANCE;
  return penalty;
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

export interface EncodeOptions {
  /** Force a mask (0 to 7) instead of choosing the best. For tests. */
  mask?: number;
  /** Start from at least this version. */
  minVersion?: number;
}

/**
 * Encode text as a QR Code. Throws a `RangeError` when it does not fit even
 * version 40 at level M (2331 bytes of UTF-8).
 */
export function encodeQr(text: string, options: EncodeOptions = {}): QrCode {
  const bytes = new TextEncoder().encode(text);
  let version = Math.max(MIN_VERSION, options.minVersion ?? MIN_VERSION);
  while (version <= MAX_VERSION && byteCapacity(version) < bytes.length) version++;
  if (version > MAX_VERSION) throw new RangeError("text is too long for a QR code");

  const symbol = new QrSymbol(version);
  symbol.placeCodewords(interleave(dataStream(bytes, version), version));

  let best = options.mask ?? 0;
  if (options.mask === undefined) {
    let bestPenalty = Infinity;
    for (let mask = 0; mask < MASK_COUNT; mask++) {
      symbol.applyMask(mask);
      symbol.drawFormat(mask);
      const penalty = penaltyScore(symbol.modules);
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        best = mask;
      }
      symbol.applyMask(mask);
    }
  }
  symbol.applyMask(best);
  symbol.drawFormat(best);
  return { version, size: symbol.size, mask: best, modules: symbol.modules };
}
