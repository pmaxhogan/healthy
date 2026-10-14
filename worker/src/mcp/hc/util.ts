/**
Small helpers the Health Connect tool modules share. Pure.

Several exist only because the Worker compiles against the ES2022 lib:
`Iterator#toArray()` and `Array#toSorted()` are newer than that.
*/

/** Every item of an iterable, as an array. */
export function listOf<T>(items: Iterable<T>): T[] {
  return [...items];
}

/** Code-unit order, not a locale's: the same order everywhere it runs. */
export function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** A sorted copy; the input is not modified. */
export function sortedBy<T>(items: Iterable<T>, compare: (left: T, right: T) => number): T[] {
  // `Array#toSorted` is ES2023; this sorts a fresh copy in place instead.
  const out = listOf(items);
  out.sort(compare);
  return out;
}

/** Names in code-unit order. */
export function sortedText(names: Iterable<string>): string[] {
  return sortedBy(names, compareText);
}

/** The distinct names of a list, in code-unit order. */
export function distinctText(names: Iterable<string>): string[] {
  return sortedText(new Set(names));
}

/** A finite number, or null for anything else. */
export function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The plain mean, or null for an empty list. */
export function meanOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Add `value` to the list filed under `key`, creating the list on first use. */
export function fileUnder<Key, Value>(map: Map<Key, Value[]>, key: Key, value: Value): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/** The map filed under `key`, created on first use. */
export function mapUnder<Key, Inner, Value>(
  map: Map<Key, Map<Inner, Value>>,
  key: Key,
): Map<Inner, Value> {
  let inner = map.get(key);
  if (inner === undefined) {
    inner = new Map();
    map.set(key, inner);
  }
  return inner;
}

/** The finite values of `data[field]` across records. */
export function numbersOf(
  records: readonly { data: Record<string, unknown> }[],
  field: string,
): number[] {
  const out: number[] = [];
  for (const record of records) {
    const value = finite(record.data[field]);
    if (value !== null) out.push(value);
  }
  return out;
}
