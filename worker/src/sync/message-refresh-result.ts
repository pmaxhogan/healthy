/**
What a message refresh reports (`portal-messages-refresh.ts`), in a module
with no imports, so the MCP tool layer and its unit tests can name the type
without pulling in D1 or the portal client.
*/

/** Why there is nothing to read. The vocabulary `sync_health_systems` uses. */
export type MessageRefreshSkip =
  | "portal_not_configured"
  | "portal_no_credentials"
  | "portal_needs_reauth"
  | "portal_not_signed_in";

/**
How one refresh ended.

 - `refreshed`: the Message Center was read and stored; `written` is how
   many messages were new or changed.
 - `skipped`: nothing to read here; `code` says why, and only the owner can
   change it.
 - `busy`: a sign-in or another refresh holds the gate (`portal_signin_busy`).
 - `failed`: the session was dead (`portal_session_expired`) or the read
   failed (the portal's stable code).
*/
export type MessageRefreshResult =
  | {
      outcome: "refreshed";
      threads: number;
      messages: number;
      written: number;
      complete: boolean;
    }
  | { outcome: "skipped"; code: MessageRefreshSkip }
  | { outcome: "busy"; code: "portal_signin_busy" }
  | { outcome: "failed"; code: string };
