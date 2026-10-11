/**
 * The small helpers the Health Connect summaries share. Pure.
 */

/** A sorted copy of `items`; the input is not modified. */
export function sortedBy<T>(items: readonly T[], compare: (left: T, right: T) => number): T[] {
  // eslint-disable-next-line unicorn/no-array-sort -- Array#toSorted is ES2023 and the Worker compiles against the ES2022 lib; this sorts a fresh copy.
  return [...items].sort(compare);
}

/**
 * The `q` quantile (0 to 1) of `values` by linear interpolation between the
 * two nearest ranks: position `q * (n - 1)` in the sorted list. This is the
 * common spreadsheet method ("type 7", `PERCENTILE.INC`), chosen so a reader
 * can check a quartile by hand: for [10, 20, 30, 40, 50] the quartiles are 20
 * and 40, and for [10, 20, 30, 40] they are 17.5 and 32.5.
 *
 * Null for an empty list. The input is not modified.
 */
export function quantile(values: readonly number[], q: number): number | null {
  return quantileOfSorted(
    sortedBy(values, (left, right) => left - right),
    q,
  );
}

/** {@link quantile} for a list that is already in ascending order. */
export function quantileOfSorted(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const position = Math.min(1, Math.max(0, q)) * (sorted.length - 1);
  const below = Math.floor(position);
  const low = sorted[below] ?? 0;
  const high = sorted[Math.min(below + 1, sorted.length - 1)] ?? low;
  return low + (high - low) * (position - below);
}

/** The first index of an ascending list whose value is not below `value`. */
export function lowerBound(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((sorted[middle] ?? Infinity) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The plain mean, or null for an empty list. */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}
