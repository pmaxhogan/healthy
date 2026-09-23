// A module-level toast queue. One per app, so any view can raise one without a
// provide/inject chain or a prop drilled through the layout.

import { reactive } from "vue";

type ToastTone = "success" | "error" | "info";

/** A button on the toast itself, for a message whose fix is one click away. */
interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  tone: ToastTone;
  text: string;
  action?: ToastAction;
}

const DISMISS_AFTER_MS = 6000;

// A counter in an object rather than a bare `let`: the ids only have to be
// distinct within one page load, and a mutable module-level binding written from
// inside a function is exactly what unicorn/no-top-level-assignment-in-function
// objects to.
const sequence = { next: 1 };

export const toasts = reactive<Toast[]>([]);

export function dismissToast(id: number): void {
  const index = toasts.findIndex((toast) => toast.id === id);
  if (index !== -1) toasts.splice(index, 1);
}

function push(tone: ToastTone, text: string, action?: ToastAction): void {
  const id = sequence.next;
  sequence.next += 1;
  toasts.push({ id, tone, text, ...(action && { action }) });
  // Errors stay until dismissed: a failure the owner blinked past is a failure
  // they will not know about, and this dashboard is the only place it surfaces.
  // So does anything that asks the owner to act.
  if (tone !== "error" && action === undefined) {
    setTimeout(() => {
      dismissToast(id);
    }, DISMISS_AFTER_MS);
  }
}

export function toastSuccess(text: string): void {
  push("success", text);
}

export function toastError(text: string): void {
  push("error", text);
}

/** An info toast with one button. Stays until it is used or dismissed. */
export function toastAction(text: string, action: ToastAction): void {
  push("info", text, action);
}
