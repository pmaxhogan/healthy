/**
 * The bridge: turn a signed-in shell session into a classic chart session.
 *
 * On a `custom_oidc` deployment the two halves of the portal are two
 * applications. The shell holds the password and the emailed code; the classic
 * pages hold the visits. What joins them is an ordinary OAuth2 authorization-code
 * flow that the classic side starts: `<mount>/Authentication/Login` 302s to
 * `<mount>/OpenId?op=...`, whose page is one hidden form -- the authorization
 * request, already minted server-side, nonce, state and PKCE challenge and all --
 * plus a script whose only job is to submit it. The shell's cookies are what make
 * the authorize hop answer with a code instead of a login screen, and the code
 * comes back to a redirect URI under the mount, where the classic application
 * exchanges it and finally sets *its* session cookie.
 *
 * So the bridge is not a protocol implementation. It is a browser: follow the
 * chain with the jar attached, do the one thing a fetch client does not do for
 * free -- submit the form a script would have submitted -- and stop when the
 * chain lands somewhere authenticated.
 *
 * What that means for the code below:
 *
 *  - **No PKCE is generated here.** The verifier belongs to whichever side minted
 *    the challenge, and that is the server: the stub's script only copies the
 *    values it was handed into `sessionStorage`. Minting our own would produce a
 *    challenge the token exchange could not verify. `wire-custom.ts` records this
 *    as an assumption, because it is one.
 *  - **Every hop goes through the jar.** That is the entire mechanism: the shell's
 *    cookie authorises the authorize hop, and the classic session cookie arrives
 *    on one of the later ones.
 *  - **The hop budget is the loop's bound, and exhausting it is a failure.** An
 *    authorization chain that will not terminate is a portal that will not sign us
 *    in, which is `portal_login_failed` -- not a parse problem and not a retry.
 *  - **Nothing is logged but a hop count and a status.** Not a URL: these carry
 *    the mount, the host, an authorization code and a state nonce.
 */

import { AppError } from "../../../lib/errors.ts";
import { sessionLandingOf } from "../client.ts";
import { autoSubmitForm } from "../html.ts";
import { isOpenIdHandoff, mountedUrl, pathOf, portalFetch } from "../http.ts";
import { PATHS } from "../wire.ts";

import { fetchAuthCodeUrl } from "./api.ts";
import { BRIDGE_MAX_HOPS, OIDC_FORM_IDS, SHELL_LOGIN_MARKERS } from "./wire-custom.ts";

import type { ShellApi } from "./api.ts";
import type { Logger } from "../../../lib/log.ts";
import type { PortalRequest, PortalResponse } from "../http.ts";

export interface BridgeDeps {
  api: ShellApi;
  logger: Logger;
  /** Origin of the classic pages. */
  baseUrl: string;
  /** Their mount, with both slashes. */
  mountPath: string;
  /**
   * The liveness check to confirm a landing with. Injected rather than
   * reimplemented: the classic client already knows how to ask, and the answer
   * to "did the bridge work" is exactly the answer to "is the session alive".
   * It only says yes for a request that ends on the classic `Home` page, so a
   * bridge that is confirmed this way has, in effect, finished there.
   */
  isSessionAlive: () => Promise<boolean>;
  maxHops?: number | undefined;
}

/** What the chain landed on, which is the only thing the bridge reads. */
type Landing = "authenticated" | "shell_login" | "handoff" | "unknown";

function landingOf(response: PortalResponse, mountPath: string): Landing {
  const path = pathOf(response.url);
  // The mount's own landing page, and nothing else, counts as arrived -- judged
  // by exactly the rule the liveness check uses, so "the bridge worked" and "the
  // session is alive" can never disagree about the same page. Checked first
  // because it is the only positive answer there is.
  if (response.status === 200 && sessionLandingOf(response, mountPath) === "home") {
    return "authenticated";
  }
  // The handoff before the shell's login route, because the classic login path
  // contains the substring `/login` too: a stub served *at* that path would
  // otherwise read as a credential failure rather than as a hop to follow.
  if (isOpenIdHandoff(response)) return "handoff";
  return SHELL_LOGIN_MARKERS.some((marker) => path.includes(marker)) ? "shell_login" : "unknown";
}

/** The request a page asks for next, or null when it asks for nothing. */
async function nextRequest(
  response: PortalResponse,
  deps: BridgeDeps,
): Promise<PortalRequest | null> {
  // The form a script would have submitted: the authorization request itself.
  const form = autoSubmitForm(response.body, OIDC_FORM_IDS);
  if (form !== null) {
    let action: string;
    try {
      action = new URL(form.action, response.url).href;
    } catch {
      return null;
    }
    return {
      url: action,
      method: "POST",
      endpoint: "OidcAuthorize",
      accept: "html",
      followBodyRedirects: true,
      form: Object.fromEntries(form.fields),
    };
  }
  // No form: ask the shell where to go instead. Only worth trying on the stub --
  // an arbitrary page that happens to be unrecognised is not a handoff.
  if (landingOf(response, deps.mountPath) !== "handoff") return null;
  const url = await fetchAuthCodeUrl(deps.api);
  if (url === null) return null;
  let absolute: string;
  try {
    absolute = new URL(url, deps.api.authBaseUrl).href;
  } catch {
    return null;
  }
  return { url: absolute, endpoint: "OidcReturn", accept: "html", followBodyRedirects: true };
}

function failed(
  logger: Logger,
  hops: number,
  status: number,
  reason: string,
  landed: Landing,
): AppError {
  // Logged here because `errorFields` never carries `details`: without this line
  // a failed handoff is one bare `portal_login_failed` with no way to tell a
  // shell login screen from a chain that simply stopped short of `Home`.
  logger.warn("portal.oidc_bridge_failed", { hops, status, reason, landed });
  return new AppError("portal_login_failed", "the OpenID handoff did not sign us in", {
    endpoint: "OidcBridge",
    hops,
    status,
    reason,
  });
}

/**
 * Follow the handoff until the classic session exists.
 *
 * Throws `portal_login_failed` when a hop lands on the shell's login screen (the
 * app-level session was not good after all), when a page asks for nothing further
 * and the session still is not alive, or when the hop budget runs out.
 */
export async function bridgeToClassicSession(deps: BridgeDeps): Promise<void> {
  const limit = deps.maxHops ?? BRIDGE_MAX_HOPS;
  let response = await portalFetch(deps.api.http, {
    url: mountedUrl(deps.baseUrl, deps.mountPath, PATHS.login),
    endpoint: "OidcStart",
    accept: "html",
    followBodyRedirects: true,
  });

  for (let hops = 0; hops < limit; hops++) {
    const landing = landingOf(response, deps.mountPath);
    if (landing === "authenticated") {
      deps.logger.info("portal.oidc_bridged", { hops, status: response.status });
      return;
    }
    if (landing === "shell_login") {
      throw failed(deps.logger, hops, response.status, "shell_login", landing);
    }

    const request = await nextRequest(response, deps);
    if (request === null) {
      // Nothing left to follow. The chain may nonetheless have set the session
      // cookie on a hop whose landing page this code does not recognise, so go
      // to `Home` and look -- which is positive evidence, not a guess: the probe
      // only answers yes for a chain that ends on the classic landing page.
      if (await deps.isSessionAlive()) {
        deps.logger.info("portal.oidc_bridged", { hops, status: response.status, viaProbe: true });
        return;
      }
      throw failed(deps.logger, hops, response.status, "no_further_hop", landing);
    }
    response = await portalFetch(deps.api.http, request);
  }

  throw failed(
    deps.logger,
    limit,
    response.status,
    "hop_budget",
    landingOf(response, deps.mountPath),
  );
}
