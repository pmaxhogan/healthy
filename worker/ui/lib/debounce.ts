// Brand search fires on every keystroke, and the brands index is large enough
// that a request per character is rude to the Worker and useless to the owner.

export const SEARCH_DEBOUNCE_MS = 250;

export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  /** Drops a pending call. Used when a component unmounts mid-type. */
  cancel: () => void;
}

/** Calls `fn` once `waitMs` has passed with no further calls. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number = SEARCH_DEBOUNCE_MS,
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const wrapped = (...args: A): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, waitMs);
  };

  wrapped.cancel = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  return wrapped;
}
