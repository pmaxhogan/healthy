/**
 * A `PortalClient` for the deployment style whose login lives in a separate shell.
 *
 * The sign-in job knows nothing about any of this. It calls `login`, then
 * `secondaryValidation.sendCode`, then `secondaryValidation.validate`, exactly as
 * it does for the classic pages -- so this file's job is to make three completely
 * different HTTP conversations look like those three calls, and to leave a live
 * classic session behind when it is done.
 *
 * The shape of it:
 *
 *  - `login` POSTs the credentials at the shell's API. If the shell wants a code,
 *    that is `awaiting_code` and nothing else happens. If it does not, the OIDC
 *    bridge runs immediately, because "signed in" has to mean the classic session
 *    exists -- the caller marks the account active on the strength of it.
 *  - `sendCode` needs three values the classic flow never had: the user id the
 *    login answered with, a per-attempt correlation number, and a contact to send
 *    to. All three go into the jar's `extras`, because **the code is submitted in
 *    a different Worker invocation by a brand-new client** (see
 *    `worker/sync/portal-runner.ts`), and the sealed jar is the only thing that
 *    invocation inherits.
 *  - `validate` submits the code with the same correlation number, then mints a
 *    trust-this-device token itself and puts it in the jar by hand -- it is a
 *    cookie the shell's own script writes, so no `Set-Cookie` ever carries it --
 *    and then runs the bridge.
 *  - Everything after sign-in is the classic client, unchanged. The visits
 *    endpoints are identical; only the way in differs.
 *
 * Two configuration values cannot be defaulted and are not guessed. The shell's
 * API base names the organisation, so it comes from discovery or from the caller;
 * without it this client refuses to start rather than probing. The MFA contact is
 * looked for in the login response, then in the caller's settings, then from the
 * shell -- and if all three come up empty, the failure says so.
 */

import { AppError, isAppError } from "../../../lib/errors.ts";
import { createMyChartClient } from "../client.ts";

import {
  fetchContact,
  postGenerateCode,
  postLogin,
  postValidateCode,
  saveTrustToken,
} from "./api.ts";
import { bridgeToClassicSession } from "./bridge.ts";
import { JAR_EXTRAS, REMEMBER_ME_COOKIE_SUFFIX } from "./wire-custom.ts";

import type { ShellApi } from "./api.ts";
import type { PortalClient, PortalClientDeps, PortalCredentials } from "../client.ts";
import type { PortalHttpDeps } from "../http.ts";
import type { PortalVisit } from "../visits.ts";
import type { PortalSignInStatus } from "@shared/types.ts";

/**
 * What the owner has to supply for this flavour, when discovery could not.
 *
 * Both are optional, and both have a reason they are not in the endpoint JSON:
 * `apiBasePath` is usually discovered and this is the fallback, and `mfaContact`
 * is usually in the login response and this is the override.
 */
export interface PortalCustomSettings {
  /** The shell API's path prefix. Overrides the discovered one when both exist. */
  apiBasePath?: string | undefined;
  /** Where the emailed code should be sent, when the shell will not say. */
  mfaContact?: string | undefined;
}

export interface CustomOidcClientDeps extends PortalClientDeps {
  custom?: PortalCustomSettings | undefined;
}

/** Fail the same way every time the API base is missing, with a reason. */
function requireApiBase(deps: CustomOidcClientDeps): string {
  const configured = deps.custom?.apiBasePath;
  const discovered = deps.endpoint.apiBasePath;
  const base = configured ?? discovered;
  if (base === undefined || base.trim() === "") {
    // Not a portal failure: the owner has to supply a value nothing can guess.
    throw new AppError("portal_discovery_failed", "the portal's login API base is not known", {
      reason: "api_base_unknown",
    });
  }
  return base.startsWith("/") ? base : `/${base}`;
}

export function createCustomOidcClient(deps: CustomOidcClientDeps): PortalClient {
  const { endpoint, jar, logger } = deps;
  const http: PortalHttpDeps = {
    fetchImpl: deps.fetchImpl,
    logger,
    jar,
    maxRedirects: deps.maxRedirects,
  };
  // The read side, unchanged: same endpoints, same antiforgery dance, same
  // parsing. Only `login` and the two-step differ, and they are below.
  const classic = createMyChartClient(deps);

  const shell = (): ShellApi => ({
    http,
    authBaseUrl: endpoint.authBaseUrl ?? endpoint.baseUrl,
    apiBasePath: requireApiBase(deps),
  });

  const bridge = async (): Promise<void> => {
    const api = shell();
    await bridgeToClassicSession({
      api,
      logger,
      baseUrl: endpoint.baseUrl,
      mountPath: endpoint.mountPath,
      isSessionAlive: () => classic.isSessionAlive(),
    });
  };

  /** The user id every MFA call is keyed on, from this attempt or the last one. */
  const userIdOrThrow = (): string => {
    const stored = jar.getExtra(JAR_EXTRAS.userId);
    if (stored === null) {
      throw new AppError("portal_login_failed", "the shell did not say who signed in", {
        endpoint: "ShellLogin",
        reason: "user_id_unknown",
      });
    }
    return stored;
  };

  const login = async (credentials: PortalCredentials): Promise<PortalSignInStatus> => {
    const outcome = await postLogin(shell(), credentials);
    // Written before the branch: even a login that needs no code leaves the id
    // behind, so a later `sendCode` on a re-used session has something to key on.
    if (outcome.userId !== null) jar.setExtra(JAR_EXTRAS.userId, outcome.userId);
    if (outcome.contact !== null) jar.setExtra(JAR_EXTRAS.contact, outcome.contact);

    if (outcome.mfaRequired) {
      logger.info("portal.login", { signInStatus: "awaiting_code", flavor: endpoint.flavor });
      return "awaiting_code";
    }
    // "Signed in" has to mean the classic session exists, because that is what
    // the caller marks the account active on.
    try {
      await bridge();
    } catch (error) {
      // A response that named neither "code needed" nor "signed in" is silence,
      // not a no-code sign-in -- and a shell that is still waiting for its code
      // is exactly what makes the handoff stop short of the classic session.
      // So in that one case a failed bridge means "ask for the code", which the
      // sign-in job already knows how to do. An explicit "signed in" that then
      // fails to bridge is a real handoff failure and stays one.
      const ambiguous = !outcome.signedInStated && outcome.userId !== null;
      if (!ambiguous || !isAppError(error) || error.code !== "portal_login_failed") throw error;
      logger.info("portal.login", {
        signInStatus: "awaiting_code",
        flavor: endpoint.flavor,
        inferred: true,
      });
      return "awaiting_code";
    }
    logger.info("portal.login", { signInStatus: "signed_in", flavor: endpoint.flavor });
    return "signed_in";
  };

  /** Where the code goes: the login response, then the owner, then the shell. */
  const contactOrThrow = async (api: ShellApi, userId: string): Promise<string> => {
    const known = jar.getExtra(JAR_EXTRAS.contact) ?? deps.custom?.mfaContact ?? "";
    if (known !== "") return known;
    const asked = await fetchContact(api, userId);
    if (asked !== null) {
      jar.setExtra(JAR_EXTRAS.contact, asked);
      return asked;
    }
    throw new AppError("portal_login_failed", "there is no address to send a code to", {
      endpoint: "GenerateCode",
      reason: "mfa_contact_unknown",
    });
  };

  const sendCode = async (channel: "email"): Promise<void> => {
    const api = shell();
    const userId = userIdOrThrow();
    // A per-attempt correlation number, which `validate` has to echo. Milliseconds
    // from the injected clock rather than `Date.now()`, so a test can pin it.
    const clientId = deps.now() * 1000;
    jar.setExtra(JAR_EXTRAS.clientId, String(clientId));
    const contact = await contactOrThrow(api, userId);
    await postGenerateCode(api, { channel, contact, userId, clientId });
    logger.info("portal.code_requested", { channel, flavor: endpoint.flavor });
  };

  /**
   * Mint a trust-this-device token and ask the shell to remember it.
   *
   * A cookie, not a form field: the token still ends up in the jar by hand
   * because nothing in the response chain sets it. But the token itself is
   * *minted here*, not fetched -- a live capture of the shell's own client code
   * found `saveTrustThisDeviceToken` takes a browser-generated token as
   * `rememberMeToken`, the reverse of what an earlier version of this file
   * assumed. `generateDeviceId` is reused rather than adding a second
   * randomness hook: it already means "mint an opaque per-device id a test can
   * pin," which is exactly what this is too. Failing is not a sign-in failure
   * -- it costs one extra emailed code next time.
   */
  const remember = async (api: ShellApi, userId: string): Promise<void> => {
    const name = `${userId}${REMEMBER_ME_COOKIE_SUFFIX}`;
    if (jar.has(api.authBaseUrl, name)) return;
    const mintId = deps.generateDeviceId ?? ((): string => crypto.randomUUID());
    const token = mintId();
    const saved = await saveTrustToken(api, { userId, rememberMeToken: token });
    if (!saved) {
      logger.warn("portal.trust_token_not_saved", { flavor: endpoint.flavor });
      return;
    }
    // Session-scoped on purpose: this jar persists session cookies by design, and
    // the server is the thing that decides when the token stops being good.
    jar.setCookie(api.authBaseUrl, `${name}=${token}; Path=/; Secure`);
  };

  const validate = async (code: string, rememberMe = true): Promise<void> => {
    const api = shell();
    const userId = userIdOrThrow();
    const stored = jar.getExtra(JAR_EXTRAS.clientId);
    const clientId = stored === null ? NaN : Number(stored);
    if (!Number.isFinite(clientId)) {
      // The generate call's correlation number is gone, so this code cannot be
      // submitted at all. A whole fresh login is the only way forward.
      throw new AppError("portal_login_failed", "the verification attempt was lost", {
        endpoint: "ValidateCode",
        reason: "mfa_state_missing",
      });
    }
    await postValidateCode(api, { code, clientId });
    if (rememberMe) await remember(api, userId);
    await bridge();
    logger.info("portal.validated", { rememberMe, flavor: endpoint.flavor });
  };

  return {
    login,
    secondaryValidation: { sendCode, validate },
    loadUpcoming: (timeZone: string): Promise<PortalVisit[]> => classic.loadUpcoming(timeZone),
    loadPast: (timeZone: string, oldestRenderedDate?: string): Promise<PortalVisit[]> =>
      classic.loadPast(timeZone, oldestRenderedDate),
    isSessionAlive: (): Promise<boolean> => classic.isSessionAlive(),
    jar,
  };
}
