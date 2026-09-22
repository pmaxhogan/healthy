/**
 * Records real Epic sandbox FHIR responses as test fixtures for a synthetic
 * test patient.
 *
 *   npm run record-fixtures -- --client-id <nonprod client id>
 *   npm run record-fixtures -- --client-id <id> --client-secret <secret>
 *   npm run record-fixtures -- --client-id <id> --out test/fixtures/epic-sandbox --patient camila
 *
 * What it does: stands up a one-shot HTTP server on
 * `http://localhost:8787/oauth/callback` (the redirect URI already registered
 * with Epic for local development), builds and prints the sandbox authorize
 * URL, opens it in the OS default browser, exchanges the code that comes back
 * for tokens, then runs every search in `SEARCH_REGISTRY` for the returned
 * patient, a `Patient` read, and reads of up to twenty referenced
 * Practitioner/Location/Organization resources. Every response is scrubbed
 * (`scripts/lib/scrub-fixture.ts`) and written under `--out` as pretty JSON,
 * alongside a `manifest.json` describing what was recorded.
 *
 * It exercises the real `ProviderAdapter` and `FhirClient` implementations
 * under `worker/providers/epic/` -- not a reimplementation of them -- so a
 * recording run is also a smoke test of that code against a live server.
 *
 * Sign in with one of Epic's published sandbox test patients (e.g.
 * `fhircamila` / `epicepic1`); see Epic's "Sandbox Patients" documentation.
 * Never point `--client-id` at a production app registration: this script
 * makes no attempt to be gentle with the API it is talking to.
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";

import { isRecord } from "../worker/fhir/bundle.ts";
import { SEARCH_REGISTRY } from "../worker/fhir/search-registry.ts";
import { makeLogger } from "../worker/lib/log.ts";
import { createFhirClient } from "../worker/providers/epic/fhir-client.ts";
import { createEpicAdapter, toTokenSet } from "../worker/providers/epic/index.ts";
import { createPkce, randomState } from "../worker/providers/pkce.ts";

import { scrubFixture, truncateBundleEntries } from "./lib/scrub-fixture.ts";

import type { SmartConfig, TokenSet } from "../worker/fhir/types.ts";
import type { ProviderAdapter } from "../worker/providers/adapter.ts";
import type { FhirClient } from "../worker/providers/epic/fhir-client.ts";

/** Epic's public sandbox R4 base. Safe to name -- see .local/quest-spec.md and CLAUDE.md. */
const EPIC_SANDBOX_BASE = "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4";

/** Must match a redirect URI registered with the Epic app, and worker/oauth/epic.ts's path. */
const CALLBACK_PORT = 8787;
const CALLBACK_PATH = "/oauth/callback";
const REDIRECT_URI = `http://localhost:${String(CALLBACK_PORT)}${CALLBACK_PATH}`;

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/** "Up to 20 referenced Practitioner/Location/Organization" -- see the quest spec. */
const MAX_REFERENCE_READS = 20;
const REFERENCE_READ_TYPES = new Set(["Practitioner", "Location", "Organization"]);
const REFERENCE_RE = /^(Practitioner|Location|Organization)\/([^/]+)$/;

const DEFAULT_OUT_DIR = "test/fixtures/epic-sandbox";
const DEFAULT_PATIENT_LABEL = "default";
const DEFAULT_MAX_PER_TYPE = 25;

const TOKEN_FIELDS_TO_REDACT = new Set(["access_token", "refresh_token", "id_token"]);

interface CliArgs {
  clientId: string;
  clientSecret: string | null;
  outDir: string;
  patientLabel: string;
  maxPerType: number;
}

function printUsage(): void {
  console.error(
    [
      "Usage: npm run record-fixtures -- --client-id <nonprod client id> [options]",
      "",
      "Options:",
      "  --client-id <id>        Epic sandbox (non-production) client id. Required.",
      "  --client-secret <s>     Client secret, for a confidential app registration.",
      "                          Omit for a public client -- PKCE is always used either way.",
      "  --out <dir>             Output directory. Default: test/fixtures/epic-sandbox",
      "  --patient <label>       A short label for this recording, used in manifest.json.",
      "                          Default: default",
      "  --max-per-type <n>      Cap on entries kept per recorded Bundle page. Default: 25",
      "",
      "Starts a local server on http://localhost:8787/oauth/callback, opens the Epic",
      "sandbox authorize page in your browser, and records every SEARCH_REGISTRY",
      "search plus reference reads for the patient you sign in as.",
    ].join("\n"),
  );
}

/** Pops the next token off `remaining`, refusing to consume another flag as a value. */
function takeValue(remaining: string[], flag: string): string {
  const value = remaining.shift();
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv: readonly string[]): CliArgs {
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  let clientId: string | null = null;
  let clientSecret: string | null = null;
  let outDir = DEFAULT_OUT_DIR;
  let patientLabel = DEFAULT_PATIENT_LABEL;
  let maxPerType = DEFAULT_MAX_PER_TYPE;

  // A shift-based queue rather than an indexed for-loop: each flag consumes a
  // variable number of following tokens (0 or 1), which reads far more simply
  // as "take what this flag needs" than as index arithmetic.
  const remaining = [...argv];
  for (let flag = remaining.shift(); flag !== undefined; flag = remaining.shift()) {
    switch (flag) {
      case "--client-id": {
        clientId = takeValue(remaining, flag);
        continue;
      }
      case "--client-secret": {
        clientSecret = takeValue(remaining, flag);
        continue;
      }
      case "--out": {
        outDir = takeValue(remaining, flag);
        continue;
      }
      case "--patient": {
        patientLabel = takeValue(remaining, flag);
        continue;
      }
      case "--max-per-type": {
        const raw = takeValue(remaining, flag);
        const parsed = Number(raw);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          throw new Error(`--max-per-type must be a positive integer, got ${raw}`);
        }
        maxPerType = parsed;
        continue;
      }
      default: {
        throw new Error(`unrecognized argument: ${flag}`);
      }
    }
  }

  if (clientId === null || clientId === "") {
    throw new Error("--client-id is required");
  }
  return { clientId, clientSecret, outDir, patientLabel, maxPerType };
}

/** What one recorded fetch reports back to whichever sink is currently listening. */
type FetchSink = (body: unknown, status: number) => void | Promise<void>;

/** Runs `fn` with `sink` wired up to every fetch that happens during it. */
type WithSink = <T>(sink: FetchSink, fn: () => Promise<T>) => Promise<T>;

interface RecordingFetch {
  fetchImpl: typeof fetch;
  withSink: WithSink;
}

/**
 * A `fetch` wrapper that lets the rest of this script observe every response
 * body the real adapter/client code sees, without changing what they receive.
 *
 * Only one sink is active at a time: this script is a strictly sequential
 * recording session, never a concurrent one, so a single closed-over "current
 * sink" is simpler than threading a sink through every adapter and client
 * call. It lives in this closure rather than at module scope so that mutating
 * it is ordinary closure state, not a shared global.
 */
function createRecordingFetch(inner: typeof fetch): RecordingFetch {
  let active: FetchSink | null = null;

  const fetchImpl: typeof fetch = async (input, init) => {
    const response = await inner(input, init);
    const sink = active;
    if (sink) {
      const clone = response.clone();
      let body: unknown = null;
      try {
        const text = await clone.text();
        body = text.trim() === "" ? null : (JSON.parse(text) as unknown);
      } catch {
        // Not JSON, or the body could not be read. Leave `body` null; a sink
        // that only records 2xx JSON responses will simply skip this one.
      }
      await sink(body, response.status);
    }
    return response;
  };

  const withSink: WithSink = async (sink, fn) => {
    active = sink;
    try {
      return await fn();
    } finally {
      active = null;
    }
  };

  return { fetchImpl, withSink };
}

async function writeJsonFile(outDir: string, filename: string, data: unknown): Promise<void> {
  const filePath = path.join(outDir, filename);
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/** Scrub, truncate, and write one recorded page. Skips non-2xx responses. */
function makePageSink(
  outDir: string,
  resourceType: string,
  label: string,
  maxPerType: number,
  writes: Promise<void>[],
): FetchSink {
  let page = 0;
  return (body, status) => {
    if (status < 200 || status >= 300) return;
    page += 1;
    const truncated = truncateBundleEntries(body, maxPerType);
    const scrubbed = scrubFixture(truncated, { sandboxBase: EPIC_SANDBOX_BASE });
    writes.push(
      writeJsonFile(outDir, `${resourceType}.${label}.page${String(page)}.json`, scrubbed),
    );
  };
}

function redactTokenResponse(body: unknown): unknown {
  if (!isRecord(body)) return body;
  const out: Record<string, unknown> = {};
  // `out[key]`: keys from `Object.entries` of the same object, into a fresh literal.
  for (const [key, value] of Object.entries(body)) {
    out[key] = TOKEN_FIELDS_TO_REDACT.has(key) ? "REDACTED" : value;
  }
  return out;
}

/** Array-form spawn with a literal command name on every branch: none of this goes through a shell. */
function browserCommand(url: string): [string, string[]] {
  switch (process.platform) {
    case "win32": {
      // `start` is a cmd.exe builtin. The empty string is the window-title
      // argument `start` expects first; without it, a URL containing `&`
      // (any query string with more than one parameter) gets misparsed.
      return ["cmd", ["/c", "start", "", url]];
    }
    case "darwin": {
      return ["open", [url]];
    }
    default: {
      return ["xdg-open", [url]];
    }
  }
}

function openInBrowser(url: string): void {
  const [command, args] = browserCommand(url);
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch (error) {
    console.error(
      `Could not open a browser automatically (${error instanceof Error ? error.message : String(error)}); use the URL above.`,
    );
  }
}

interface CallbackResult {
  code: string | null;
  error: string | null;
}

/** Listens once on `REDIRECT_URI`, resolves on the first matching callback, then closes. */
function waitForCallback(expectedState: string): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://localhost:${String(CALLBACK_PORT)}`);
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }

      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      response
        .writeHead(200, { "content-type": "text/plain" })
        .end(
          error === null
            ? "Fixture recording received the callback. You can close this window."
            : `Epic reported an error (${error}). You can close this window and check the terminal.`,
        );
      server.close();
      clearTimeout(timer);

      if (state !== expectedState) {
        reject(new Error(`OAuth state mismatch on callback (got ${state ?? "<none>"})`));
        return;
      }
      resolve({ code, error });
    });

    const timer = setTimeout(() => {
      server.close();
      reject(
        new Error(`timed out after ${String(CALLBACK_TIMEOUT_MS)} ms waiting for the callback`),
      );
    }, CALLBACK_TIMEOUT_MS);
    timer.unref();

    server.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.listen(CALLBACK_PORT, () => {
      console.error(`Listening for the Epic OAuth callback on ${REDIRECT_URI}`);
    });
  });
}

interface ExchangeArgs {
  clientId: string;
  clientSecret: string | null;
  code: string;
  codeVerifier: string;
}

/**
 * Exchange the authorization code for tokens, recording the raw (redacted)
 * response either way, and writes `token-response.scrubbed.json` itself.
 *
 * With a client secret this simply calls the real adapter, which tries HTTP
 * Basic first per the module comment on `worker/providers/epic/index.ts`.
 * Without one, `ProviderAdapter.exchangeCode` has no "send no credentials at
 * all" mode to call into -- every path it has sends *something* -- so this
 * does the public-client token POST by hand: no Authorization header, no
 * `client_secret` field, relying on the PKCE verifier alone (RFC 7636). The
 * sandbox may accept either shape for a given app registration; this is an
 * assumption this script cannot verify without a live client id.
 */
async function exchangeCodeAndRecord(
  adapter: ProviderAdapter,
  config: SmartConfig,
  args: ExchangeArgs,
  recording: RecordingFetch,
  outDir: string,
): Promise<TokenSet> {
  let rawBody: unknown = null;
  const sink: FetchSink = (body, status) => {
    if (status >= 200 && status < 300) rawBody = body;
  };

  try {
    return await recording.withSink(sink, async () => {
      if (args.clientSecret !== null) {
        return adapter.exchangeCode({
          tokenUrl: config.tokenUrl,
          clientId: args.clientId,
          clientSecret: args.clientSecret,
          code: args.code,
          redirectUri: REDIRECT_URI,
          codeVerifier: args.codeVerifier,
          tokenAuthMethods: config.tokenAuthMethods,
        });
      }

      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: args.code,
        redirect_uri: REDIRECT_URI,
        code_verifier: args.codeVerifier,
        client_id: args.clientId,
      });
      const response = await recording.fetchImpl(config.tokenUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
      let parsed: unknown = null;
      try {
        parsed = await response.json();
      } catch {
        // Handled by the response.ok check below via toTokenSet's own error.
      }
      if (response.ok) return toTokenSet(parsed, Date.now());
      throw new Error(`public-client token exchange failed with HTTP ${String(response.status)}`);
    });
  } finally {
    await writeJsonFile(outDir, "token-response.scrubbed.json", redactTokenResponse(rawBody));
  }
}

/** Every `Practitioner/Location/Organization` reference found anywhere in `resources`. */
function collectReferences(resources: readonly unknown[]): { resourceType: string; id: string }[] {
  const seen = new Map<string, { resourceType: string; id: string }>();

  function walk(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!isRecord(value)) return;
    const reference = value.reference;
    if (typeof reference === "string") {
      const match = REFERENCE_RE.exec(reference);
      const resourceType = match?.[1];
      const id = match?.[2];
      if (
        resourceType !== undefined &&
        id !== undefined &&
        REFERENCE_READ_TYPES.has(resourceType)
      ) {
        seen.set(`${resourceType}/${id}`, { resourceType, id });
      }
    }
    for (const nested of Object.values(value)) walk(nested);
  }

  for (const resource of resources) walk(resource);
  // Iterator#toArray would need the esnext.iterator lib, and this project's Node
  // tsconfig is ES2024 + ESNext.Array only (the same tradeoff as Array#toSorted
  // in worker/fhir/search-registry.ts's `dedupe`).
  // eslint-disable-next-line unicorn/prefer-iterator-to-array
  return [...seen.values()];
}

interface ManifestWarning {
  resourceType: string;
  label: string;
  severity: string;
  code: string;
  epicCode: string | null;
}

interface ManifestError {
  resourceType: string;
  label: string;
  message: string;
}

interface Manifest {
  label: string;
  patientId: string;
  recordedAt: string;
  counts: Record<string, number>;
  warnings: ManifestWarning[];
  errors: ManifestError[];
}

/** `entry.params(patientId)` gives one search per category; this names each one for the filename. */
function labelFor(params: Record<string, string>): string {
  return params.category ?? "search";
}

async function recordSearches(
  client: FhirClient,
  patientId: string,
  outDir: string,
  maxPerType: number,
  recording: RecordingFetch,
  counts: Map<string, number>,
  warnings: ManifestWarning[],
  errors: ManifestError[],
): Promise<{ resources: unknown[] }> {
  const allResources: unknown[] = [];

  for (const entry of SEARCH_REGISTRY) {
    if (entry.mode !== "search") continue; // read-mode entries are resolved by reference below

    for (const params of entry.params(patientId)) {
      const label = labelFor(params);
      const writes: Promise<void>[] = [];
      const sink = makePageSink(outDir, entry.resourceType, label, maxPerType, writes);
      try {
        const result = await recording.withSink(sink, () =>
          client.search(entry.resourceType, params),
        );
        await Promise.all(writes);
        counts.set(
          entry.resourceType,
          (counts.get(entry.resourceType) ?? 0) + result.resources.length,
        );
        for (const warning of result.warnings) {
          warnings.push({
            resourceType: warning.resourceType,
            label,
            severity: warning.severity,
            code: warning.code,
            epicCode: warning.epicCode,
          });
        }
        allResources.push(...result.resources);
        console.error(
          `  ${entry.resourceType} (${label}): ${String(result.resources.length)} resources`,
        );
      } catch (error) {
        await Promise.all(writes);
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ resourceType: entry.resourceType, label, message });
        console.error(`  ! ${entry.resourceType} (${label}) failed: ${message}`);
      }
    }
  }

  return { resources: allResources };
}

async function recordPatientRead(
  client: FhirClient,
  patientId: string,
  outDir: string,
  maxPerType: number,
  recording: RecordingFetch,
  counts: Map<string, number>,
  errors: ManifestError[],
): Promise<unknown> {
  const writes: Promise<void>[] = [];
  const sink = makePageSink(outDir, "Patient", "read", maxPerType, writes);
  try {
    const patient = await recording.withSink(sink, () => client.read("Patient", patientId));
    await Promise.all(writes);
    if (patient) {
      counts.set("Patient", 1);
      console.error("  Patient (read): 1 resource");
    }
    return patient;
  } catch (error) {
    await Promise.all(writes);
    const message = error instanceof Error ? error.message : String(error);
    errors.push({ resourceType: "Patient", label: "read", message });
    console.error(`  ! Patient (read) failed: ${message}`);
    return null;
  }
}

async function recordReferenceReads(
  client: FhirClient,
  references: readonly { resourceType: string; id: string }[],
  outDir: string,
  maxPerType: number,
  recording: RecordingFetch,
  counts: Map<string, number>,
  errors: ManifestError[],
): Promise<void> {
  const capped = references.slice(0, MAX_REFERENCE_READS);
  console.error(
    `Resolving ${String(capped.length)} referenced resource(s) (of ${String(references.length)} found)...`,
  );

  for (const ref of capped) {
    const writes: Promise<void>[] = [];
    const sink = makePageSink(outDir, ref.resourceType, "read", maxPerType, writes);
    try {
      const resource = await recording.withSink(sink, () => client.read(ref.resourceType, ref.id));
      await Promise.all(writes);
      if (resource) counts.set(ref.resourceType, (counts.get(ref.resourceType) ?? 0) + 1);
    } catch (error) {
      await Promise.all(writes);
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ resourceType: ref.resourceType, label: "read", message });
      console.error(`  ! ${ref.resourceType}/${ref.id} (read) failed: ${message}`);
    }
  }
}

/** Discovery and CapabilityStatement, each recorded verbatim (scrubbed) as its own fixture. */
async function recordDiscoveryDocs(
  adapter: ProviderAdapter,
  recording: RecordingFetch,
  outDir: string,
): Promise<SmartConfig> {
  let smartRaw: unknown = null;
  const smartSink: FetchSink = (body, status) => {
    if (status >= 200 && status < 300) smartRaw = body;
  };
  const config = await recording.withSink(smartSink, () => adapter.discover(EPIC_SANDBOX_BASE));
  await writeJsonFile(
    outDir,
    "smart-configuration.json",
    scrubFixture(smartRaw, { sandboxBase: EPIC_SANDBOX_BASE }),
  );
  return config;
}

async function recordMetadata(
  adapter: ProviderAdapter,
  accessToken: string,
  recording: RecordingFetch,
  outDir: string,
): Promise<void> {
  let metadataRaw: unknown = null;
  const sink: FetchSink = (body, status) => {
    if (status >= 200 && status < 300) metadataRaw = body;
  };
  await recording.withSink(sink, () => adapter.getCapabilities(EPIC_SANDBOX_BASE, accessToken));
  await writeJsonFile(
    outDir,
    "metadata.json",
    scrubFixture(metadataRaw, { sandboxBase: EPIC_SANDBOX_BASE }),
  );
}

function allResourceTypes(): string[] {
  return [...new Set(SEARCH_REGISTRY.map((entry) => entry.resourceType))];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.outDir, { recursive: true });

  const logger = makeLogger({ src: "record-fixtures" }, { minLevel: "warn" });
  const recording = createRecordingFetch(fetch);
  const adapter = createEpicAdapter({ fetchImpl: recording.fetchImpl, logger, now: Date.now });

  console.error(`Discovering ${EPIC_SANDBOX_BASE} ...`);
  const config = await recordDiscoveryDocs(adapter, recording, args.outDir);

  const pkce = await createPkce();
  const state = randomState();
  const authorizeUrl = adapter.buildAuthorizeUrl({
    authorizeUrl: config.authorizeUrl,
    clientId: args.clientId,
    redirectUri: REDIRECT_URI,
    scopes: adapter.scopesFor(allResourceTypes()),
    state,
    codeChallenge: pkce.challenge,
    aud: EPIC_SANDBOX_BASE,
  });

  console.error("\nOpen this URL to sign in as a sandbox test patient:\n");
  console.error(authorizeUrl);
  console.error("");
  openInBrowser(authorizeUrl);

  const callbackPromise = waitForCallback(state);
  const callback = await callbackPromise;
  if (callback.error !== null || callback.code === null) {
    throw new Error(
      `Epic did not return an authorization code (error: ${callback.error ?? "none"})`,
    );
  }

  console.error("Exchanging the authorization code for tokens...");
  const tokens = await exchangeCodeAndRecord(
    adapter,
    config,
    {
      clientId: args.clientId,
      clientSecret: args.clientSecret,
      code: callback.code,
      codeVerifier: pkce.verifier,
    },
    recording,
    args.outDir,
  );
  console.error(`Signed in. Patient id: ${tokens.patientId}`);

  console.error("Fetching /metadata...");
  await recordMetadata(adapter, tokens.accessToken, recording, args.outDir);

  const client = createFhirClient({
    baseUrl: EPIC_SANDBOX_BASE,
    getAccessToken: () => Promise.resolve(tokens.accessToken),
    fetchImpl: recording.fetchImpl,
    logger,
    now: Date.now,
  });

  const counts = new Map<string, number>();
  const warnings: ManifestWarning[] = [];
  const errors: ManifestError[] = [];

  console.error("Reading Patient...");
  const patient = await recordPatientRead(
    client,
    tokens.patientId,
    args.outDir,
    args.maxPerType,
    recording,
    counts,
    errors,
  );

  console.error("Running every SEARCH_REGISTRY search...");
  const { resources } = await recordSearches(
    client,
    tokens.patientId,
    args.outDir,
    args.maxPerType,
    recording,
    counts,
    warnings,
    errors,
  );

  const references = collectReferences(patient === null ? resources : [...resources, patient]);
  await recordReferenceReads(
    client,
    references,
    args.outDir,
    args.maxPerType,
    recording,
    counts,
    errors,
  );

  const manifest: Manifest = {
    label: args.patientLabel,
    patientId: tokens.patientId,
    recordedAt: new Date().toISOString(),
    counts: Object.fromEntries(counts),
    warnings,
    errors,
  };
  await writeJsonFile(args.outDir, "manifest.json", manifest);

  console.error(
    `\nDone. Wrote fixtures to ${args.outDir} (${String(warnings.length)} warning(s), ${String(errors.length)} error(s)). See manifest.json.`,
  );
}

try {
  await main();
} catch (error) {
  console.error(
    `\nrecord-fixtures failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  printUsage();
  process.exit(1);
}
