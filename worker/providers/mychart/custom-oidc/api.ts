/**
 * The `custom_oidc` shell's JSON API: password, emailed code, trust token.
 *
 * This is the half of the strategy that is a normal API client -- a handful of
 * POSTs against documented routes, with a cookie jar. The other half, the part
 * that turns a shell session into a classic chart session, is `bridge.ts`.
 *
 * Three things shape every function here.
 *
 * **The route names are confirmed; the payloads mostly are not.** They were read
 * out of the deployment's own public bundle, so the paths and the request field
 * names are facts. The *responses* were never observed, so every reader below
 * goes through a candidate-key list from `wire-custom.ts` and degrades to a null
 * rather than throwing. `[assumption]` in that file is the index of what live QA
 * has to confirm.
 *
 * **Nothing here is logged except a status and a stable label.** The user id is
 * the owner's login name and the contact is an email address; both are arguments
 * to these functions and neither may reach a log line or an `AppError.details`.
 *
 * **A refusal is told from a failure by the body, not the status.** The shell
 * answers a wrong password with a 4xx often enough, but its own bundle carries
 * the lockout wording, so a body marker is what distinguishes `portal_locked`
 * from `portal_login_failed` -- exactly as it does on the classic pages.
 */

import { AppError } from "../../../lib/errors.ts";
import { bodyMentions } from "../html.ts";
import { portalFetch } from "../http.ts";

import {
  API_PATHS,
  CHANNEL_KEYS,
  CODE_SOURCE,
  CONTACT_KEYS,
  CUSTOM_MARKERS,
  GENERATE_FIELDS,
  LOGIN_FIELDS,
  LOGIN_RESPONSE_KEYS,
  SAVE_TRUST_TOKEN_FIELDS,
  VALIDATE_FIELDS,
} from "./wire-custom.ts";

import type { PortalHttpDeps, PortalResponse } from "../http.ts";

export interface ShellApi {
  http: PortalHttpDeps;
  /** Origin the shell is served from. Origin only, never a path. */
  authBaseUrl: string;
  /** The path its JSON API is mounted at, e.g. `/somethingwebapi`. */
  apiBasePath: string;
}

/** What the credential POST said, as far as any of it could be read. */
export interface LoginOutcome {
  /** True when the shell wants a verification code before it will sign in. */
  mfaRequired: boolean;
  /**
   * True when the response said outright that the password signed us in.
   *
   * False covers both "said no" (which never gets this far -- it is a refusal)
   * and "said nothing either way", which is the case that matters: the shell's
   * response shape is `[assumption]`, and a response that names neither flag is
   * not evidence that no code is needed. See the custom client's `login`.
   */
  signedInStated: boolean;
  /** The id every later MFA call is keyed on, lower-cased. Null when unreadable. */
  userId: string | null;
  /** Where a code can be sent, when the response volunteered it. */
  contact: string | null;
}

/** An absolute URL for one of the shell's API routes. */
function apiUrl(api: ShellApi, path: string): string {
  // `new URL` with a base collapses the slashes for us, and refuses a path that
  // tried to escape the base.
  const base = api.apiBasePath.endsWith("/") ? api.apiBasePath : `${api.apiBasePath}/`;
  return new URL(`${base}${path}`, api.authBaseUrl).href;
}

/** The hostname the shell would report as `location.hostname`. */
function portalHostOf(api: ShellApi): string {
  return new URL(api.authBaseUrl).hostname;
}

/**
 * A JSON object body as a field map.
 *
 * Empty rather than null when the body was not a JSON object, which makes every
 * reader below one expression: an unreadable response and a response that simply
 * did not mention a field are the same thing to all of them, and both degrade to
 * "said nothing" rather than to a throw.
 */
function jsonFields(response: PortalResponse): ReadonlyMap<string, unknown> {
  const trimmed = response.body.trim();
  if (!trimmed.startsWith("{")) return EMPTY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return EMPTY;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return EMPTY;
  // Entries, not indexing: the object came off the wire.
  return new Map(Object.entries(parsed));
}

const EMPTY: ReadonlyMap<string, unknown> = new Map();

/** The three ways each boolean has been seen serialised. See `yes`/`no`. */
const TRUE_VALUES: ReadonlySet<unknown> = new Set([true, 1, "true", "True"]);
const FALSE_VALUES: ReadonlySet<unknown> = new Set([false, 0, "false", "False"]);

/** The first candidate key holding a non-empty string. */
function str(fields: ReadonlyMap<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = fields.get(key);
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

/** True when a candidate key is set to something that means yes. */
function yes(fields: ReadonlyMap<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => TRUE_VALUES.has(fields.get(key)));
}

/**
 * True when a candidate key is present and says no.
 *
 * Distinct from `!yes(...)`: an absent key says nothing at all, and the whole
 * design of these readers is that silence degrades rather than fails.
 */
function no(fields: ReadonlyMap<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => FALSE_VALUES.has(fields.get(key)));
}

/**
 * Turn a refused API call into the right stable code.
 *
 * `locked` first, because it is the one that has to stop the retry loop for the
 * day; everything else is the caller's `fallback`.
 */
function refusal(response: PortalResponse, endpoint: string, fallback: "login" | "code"): AppError {
  const details = { endpoint, status: response.status };
  if (bodyMentions(response.body, CUSTOM_MARKERS.locked)) {
    return new AppError("portal_locked", "the shell locked the account", details);
  }
  return fallback === "login"
    ? new AppError("portal_login_failed", "the shell rejected the credentials", details)
    : new AppError("portal_2fa_rejected", "the shell rejected the verification code", details);
}

/** True when the call plainly did not work. */
function refused(response: PortalResponse): boolean {
  return (
    response.status >= 400 || bodyMentions(response.body, CUSTOM_MARKERS.badCredentials)
    // A 5xx never reaches here: `portalFetch` turns it into portal_unreachable.
  );
}

/**
 * POST the credentials.
 *
 * Form-urlencoded, and lower-case field names: the one route on this API that is
 * not JSON. The trust-this-device cookie, if the jar still holds one, rides along
 * as a cookie -- which is [assumption] how a remembered device skips the code.
 * The bundle also supports posting the trust token as the body's only field, and
 * this deliberately does not do that: the cookie path needs no extra state, and
 * if the assumption is wrong the only cost is one more emailed code.
 */
export async function postLogin(
  api: ShellApi,
  credentials: { username: string; password: string },
): Promise<LoginOutcome> {
  const response = await portalFetch(api.http, {
    url: apiUrl(api, API_PATHS.login),
    method: "POST",
    endpoint: "ShellLogin",
    accept: "json",
    form: {
      [LOGIN_FIELDS.username]: credentials.username,
      [LOGIN_FIELDS.password]: credentials.password,
    },
  });
  if (refused(response)) throw refusal(response, "ShellLogin", "login");

  const fields = jsonFields(response);
  // A response that matches none of the candidates reads as "no code needed",
  // which the bridge then either confirms or fails on. See `wire-custom.ts`.
  const mfaRequired = yes(fields, LOGIN_RESPONSE_KEYS.mfaRequired);
  // A 200 that says outright it did not sign anyone in, and does not want a code
  // either. The shell answers most refusals with a 4xx, but not reliably enough to
  // skip this: without it a rejected password would go on to the bridge and be
  // reported as a handoff problem.
  if (!mfaRequired && no(fields, LOGIN_RESPONSE_KEYS.signedIn)) {
    throw refusal(response, "ShellLogin", "login");
  }
  const userId = str(fields, LOGIN_RESPONSE_KEYS.userId);
  return {
    mfaRequired,
    signedInStated: yes(fields, LOGIN_RESPONSE_KEYS.signedIn),
    userId: userId === null ? null : userId.toLowerCase(),
    contact: str(fields, LOGIN_RESPONSE_KEYS.contact),
  };
}

/**
 * Ask the shell to send a code.
 *
 * The channel is the body *key*, not a value: `{ email: <contact> }`. `clientId`
 * is a per-attempt correlation number the caller mints and has to send again on
 * the validate call, which is why it is an argument rather than generated here.
 */
export async function postGenerateCode(
  api: ShellApi,
  input: { channel: "email"; contact: string; userId: string; clientId: number },
): Promise<void> {
  const response = await portalFetch(api.http, {
    url: apiUrl(api, API_PATHS.generateCode),
    method: "POST",
    endpoint: "GenerateCode",
    accept: "json",
    jsonBody: {
      [CHANNEL_KEYS[input.channel]]: input.contact,
      [GENERATE_FIELDS.userId]: input.userId,
      [GENERATE_FIELDS.clientId]: input.clientId,
      [GENERATE_FIELDS.portalHost]: portalHostOf(api),
      [GENERATE_FIELDS.source]: CODE_SOURCE,
    },
  });
  if (refused(response)) {
    // No code was sent, so there is nothing for the owner to wait for: the
    // sign-in did not start rather than the code being wrong.
    throw refusal(response, "GenerateCode", "login");
  }
}

/** Submit the code, with the same correlation id the generate call carried. */
export async function postValidateCode(
  api: ShellApi,
  input: { code: string; clientId: number },
): Promise<void> {
  const response = await portalFetch(api.http, {
    url: apiUrl(api, API_PATHS.validateCode),
    method: "POST",
    endpoint: "ValidateCode",
    accept: "json",
    jsonBody: {
      [VALIDATE_FIELDS.token]: input.code,
      [VALIDATE_FIELDS.clientId]: input.clientId,
    },
  });
  if (refused(response)) throw refusal(response, "ValidateCode", "code");
}

/**
 * Tell the shell to trust this device, with a token the *caller* mints.
 *
 * [confirmed] request shape, read out of the shell's own client code: the
 * token is generated in the browser and posted as `rememberMeToken` alongside
 * the user id. The shell answers with nothing this function reads -- the token
 * that ends up in the jar as a cookie is the one the caller already minted, not
 * anything parsed from the response. False rather than a throw on a refusal:
 * failing to be remembered costs an extra emailed code next time and nothing
 * else, so it must not fail a sign-in that has otherwise just succeeded.
 */
export async function saveTrustToken(
  api: ShellApi,
  input: { userId: string; rememberMeToken: string },
): Promise<boolean> {
  const response = await portalFetch(api.http, {
    url: apiUrl(api, API_PATHS.saveTrustToken),
    method: "POST",
    endpoint: "SaveTrustToken",
    accept: "json",
    jsonBody: {
      [GENERATE_FIELDS.userId]: input.userId,
      [SAVE_TRUST_TOKEN_FIELDS.rememberMeToken]: input.rememberMeToken,
    },
  });
  return response.status < 400;
}

/**
 * Ask the shell where a code can be sent, or null.
 *
 * The last of three sources, after the login response and the owner's own
 * configuration. Null rather than a throw for the same reason: the caller has a
 * better error to raise than this function does.
 */
export async function fetchContact(api: ShellApi, userId: string): Promise<string | null> {
  const response = await portalFetch(api.http, {
    url: `${apiUrl(api, API_PATHS.mfaContact)}?${new URLSearchParams({ [GENERATE_FIELDS.userId]: userId }).toString()}`,
    endpoint: "MfaContact",
    accept: "json",
  });
  return response.status >= 400 ? null : str(jsonFields(response), CONTACT_KEYS);
}
