// The loading / error / empty state machine every page needs, written once.
//
// Without this each view grows three refs and a try/finally, and the views stop
// fitting inside the cognitive-complexity budget. With it a view is a loader
// function and a template.

import { onUnmounted, ref, shallowRef } from "vue";

import { errorMessage, isAuthRequired } from "../api/client.ts";

import { toastError } from "./toasts.ts";

import type { Ref, ShallowRef } from "vue";

export interface Loadable<T> {
  data: ShallowRef<T | null>;
  /** True on the first load and on every reload. */
  loading: Ref<boolean>;
  /** One line, already safe to show. Null when the last load succeeded. */
  error: Ref<string | null>;
  /** Re-runs the loader. Silent reloads do not blank the page. */
  reload: () => Promise<void>;
  /** Replaces the held value without a round trip, after a successful save. */
  set: (value: T) => void;
}

/**
 * Runs `loader` now and on demand.
 *
 * In-flight requests are aborted when the component goes away or a reload
 * overtakes them, so a slow page the owner navigated off does not later
 * overwrite a fresher one.
 *
 * An `AuthRequiredError` is swallowed: the client has already started a full
 * page navigation to the login wall, and an error banner over a navigating page
 * is noise.
 */
export function useLoad<T>(loader: (signal: AbortSignal) => Promise<T>): Loadable<T> {
  const data = shallowRef<T | null>(null);
  const loading = ref(true);
  const error = ref<string | null>(null);

  let controller: AbortController | null = null;

  async function reload(): Promise<void> {
    controller?.abort();
    const own = new AbortController();
    controller = own;
    loading.value = true;
    error.value = null;
    try {
      const value = await loader(own.signal);
      if (own.signal.aborted) return;
      data.value = value;
    } catch (error_) {
      if (own.signal.aborted || isAuthRequired(error_)) return;
      error.value = errorMessage(error_);
    } finally {
      if (!own.signal.aborted) loading.value = false;
    }
  }

  onUnmounted(() => {
    controller?.abort();
  });

  void reload();

  return {
    data,
    loading,
    error,
    reload,
    set: (value: T) => {
      data.value = value;
    },
  };
}

/**
 * Wraps a mutation: disables its button while it runs, toasts on failure, and
 * never lets a rejection escape into an unhandled promise.
 *
 * Returns whether it succeeded, so callers can choose to reload only then.
 */
export function useAction(): {
  busy: Ref<boolean>;
  run: (fn: () => Promise<void>) => Promise<boolean>;
} {
  const busy = ref(false);
  return {
    busy,
    run: async (fn) => {
      if (busy.value) return false;
      busy.value = true;
      try {
        await fn();
        return true;
      } catch (error) {
        if (!isAuthRequired(error)) toastError(errorMessage(error));
        return false;
      } finally {
        busy.value = false;
      }
    },
  };
}
