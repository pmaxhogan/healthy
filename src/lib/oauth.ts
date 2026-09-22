// The OAuth entry points. They are Worker routes that redirect off-origin, so
// the UI reaches them with a full page navigation (an anchor, or
// location.assign) and never with fetch.

import type { ProviderDto } from "@shared/types.ts";

export const GOOGLE_START = "/oauth/google/start";

/**
 * Where "Connect" / "Reconnect" points for a provider.
 *
 * `connection.reconnectPath` is authoritative when there is a connection: the
 * Worker puts it in the DTO precisely so the UI does not hand-build the URL.
 * Only a provider that has never been connected falls back to the start route.
 */
export function reconnectHref(provider: ProviderDto): string {
  return (
    provider.connection?.reconnectPath ??
    `/oauth/epic/start?provider=${encodeURIComponent(provider.id)}`
  );
}
