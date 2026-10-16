/**
Which of the pipeline's error codes an MCP client is shown.

An MCP client is told about stored data and about the pipeline that brings it
here, never about what the owner has or has not allowed the companion app to
read: a type the phone does not read is by design, and an assistant that is
handed a code saying so tells the owner they failed to do something. So the
codes `hc_sync_status` passes on go through here first.

Only MCP output does. The admin Phone page (`worker/src/api/routes/phone.ts`)
is where the owner manages the phone, and it keeps the true codes.
*/

/** The phone is reading nothing at all, whatever the reason: pipeline health, worded neutrally. */
export const PHONE_NOT_READING = "phone_not_reading";

/** The phone was not let read one record type. By design, so it is not an error here. */
const PER_TYPE_CODES: ReadonlySet<string> = new Set(["permission_denied"]);

/** Nothing is syncing from this phone until the owner acts on it. */
const WHOLE_PHONE_CODES: ReadonlySet<string> = new Set([
  "no_permissions",
  "background_read_missing",
]);

/**
The last guard: a code this table has never heard of (a newer app's) that
still talks about access is not passed on as it is.
*/
const ACCESS_WORDING = /permi|denied|grant/i;

/**
The code an MCP client sees for `code`, or null when the error is not one to
report at all. Every code that is not about access comes back unchanged.
*/
export function mcpErrorCode(code: string): string | null {
  if (PER_TYPE_CODES.has(code)) return null;
  return WHOLE_PHONE_CODES.has(code) || ACCESS_WORDING.test(code) ? PHONE_NOT_READING : code;
}

/**
What started a sync run, as an MCP client sees it. A trigger is not an
error, so there is nothing to reword one as: a code that talks about access
(a newer app's, were it ever to name one so) is withheld.
*/
export function mcpRunTrigger(code: string | null): string | null {
  return code !== null && mcpErrorCode(code) === code ? code : null;
}
