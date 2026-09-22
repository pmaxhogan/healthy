#!/usr/bin/env node
// Downloads Epic's public "User-access Brands Bundle" (~90MB FHIR Bundle of
// Organization/Endpoint resources) and writes a slimmed, deduped index to
// data/epic-brands.json. See scripts/lib/slim-brands.mjs for the transform.
//
// Usage:
//   node scripts/slim-brands.mjs                 # download from Epic and write output
//   node scripts/slim-brands.mjs --input FILE     # use a local bundle file instead (offline)
//
// A plain JSON.parse of the ~90MB bundle comfortably fits Node's default heap
// (observed ~300MB RSS); no --max-old-space-size flag is needed. If Epic's
// feed grows substantially, re-run with:
//   node --max-old-space-size=4096 scripts/slim-brands.mjs

import { writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { slimBrandsBundle } from "./lib/slim-brands.mjs";

const SOURCE_URL = "https://open.epic.com/Endpoints/Brands";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "data", "epic-brands.json");

function parseArgs(argv) {
  const args = { input: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--input") {
      continue;
    }

    args.input = argv[i + 1];
    i++;
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetries(url, { retries = 3, backoffMs = 2000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      console.error(`[slim-brands] fetch attempt ${attempt} failed: ${error.message}`);
      if (attempt <= retries) {
        const delay = backoffMs * 2 ** (attempt - 1);
        console.error(`[slim-brands] retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let raw;
  if (args.input) {
    console.log(`[slim-brands] reading local bundle: ${args.input}`);
    raw = await readFile(args.input, "utf8");
  } else {
    console.log(`[slim-brands] downloading bundle from ${SOURCE_URL}`);
    const start = Date.now();
    raw = await fetchWithRetries(SOURCE_URL);
    console.log(
      `[slim-brands] downloaded ${(raw.length / 1024 / 1024).toFixed(1)}MB in ${Date.now() - start}ms`,
    );
  }

  console.log("[slim-brands] parsing JSON...");
  const bundle = JSON.parse(raw);

  console.log("[slim-brands] slimming bundle...");
  const brands = slimBrandsBundle(bundle);

  const output = {
    generatedAt: new Date().toISOString(),
    source: args.input ? args.input : SOURCE_URL,
    count: brands.length,
    brands,
  };

  const json = JSON.stringify(output, null, 2);

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, json + "\n", "utf8");

  const sizeMb = Buffer.byteLength(json, "utf8") / 1024 / 1024;
  console.log(`[slim-brands] wrote ${OUTPUT_PATH}`);
  console.log(`[slim-brands] brands: ${brands.length}, output size: ${sizeMb.toFixed(2)}MB`);
}

main().catch((error) => {
  console.error("[slim-brands] FAILED:", error.stack || error.message || error);
  process.exitCode = 1;
});
