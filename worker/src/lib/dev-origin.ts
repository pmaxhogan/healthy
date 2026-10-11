/**
 * Put a `wrangler dev` request back on the loopback origin it really arrived on.
 *
 * `wrangler.jsonc` routes the Worker to a custom domain, and `wrangler dev`
 * honours that by presenting every local request as `http://<that domain>/...`
 * (Host header included) even though it came in on `127.0.0.1`. Two things then
 * break: the OAuth provider refuses to start, because its resource
 * (`resourceFor`, built from the request's origin) is plain http on a host that
 * is not loopback, and every route answers 500. And anything that builds a link
 * from the request would point the browser at production.
 *
 * So, in development only, such a request is re-addressed to the loopback
 * origin before anything reads it: `DEV_ORIGIN` from `.dev.vars` when set
 * (`http://localhost:<port>` for a non-default port), otherwise the origin of
 * `npm run dev:worker`'s own port. Everything downstream -- the provider's
 * resource and the `/mcp` bearer check that recomputes it -- then sees one
 * consistent loopback origin.
 *
 * Production is untouched twice over: `DEV_MODE` is `"false"` in
 * `wrangler.jsonc` and only `.dev.vars` turns it on, and a production request
 * is https, which this never rewrites.
 */

/** `npm run dev:worker` listens here. `DEV_ORIGIN` overrides it. */
const DEFAULT_DEV_ORIGIN = "http://localhost:8787";

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

interface DevEnv {
  DEV_MODE?: string | undefined;
  DEV_ORIGIN?: string | undefined;
}

/** The loopback origin to use, or null when `DEV_ORIGIN` is not a loopback http(s) origin. */
function devOrigin(env: DevEnv): URL | null {
  let origin: URL;
  try {
    origin = new URL(env.DEV_ORIGIN ?? DEFAULT_DEV_ORIGIN);
  } catch {
    return null;
  }
  return LOOPBACK_HOSTS.has(origin.hostname) ? origin : null;
}

/** `request`, re-addressed to the loopback origin when it is a local dev request. */
export function toDevOrigin(request: Request, env: DevEnv): Request {
  if (env.DEV_MODE !== "true") return request;
  const url = new URL(request.url);
  if (url.protocol !== "http:" || LOOPBACK_HOSTS.has(url.hostname)) return request;
  const origin = devOrigin(env);
  if (origin === null) return request;
  const routed = url.origin;
  url.protocol = origin.protocol;
  url.host = origin.host;
  const headers = new Headers(request.headers);
  headers.set("host", origin.host);
  // `wrangler dev` rewrites a browser's `Origin` and `Referer` the same way it
  // rewrites the URL, so the same-origin proof (`worker/src/auth/csrf.ts`) would
  // compare a routed Origin against a loopback URL. Put them back too.
  const sentOrigin = headers.get("origin");
  if (sentOrigin === routed) headers.set("origin", origin.origin);
  const referer = headers.get("referer");
  if (referer?.startsWith(`${routed}/`) === true) {
    headers.set("referer", `${origin.origin}${referer.slice(routed.length)}`);
  }
  return new Request(url.href, new Request(request, { headers }));
}
