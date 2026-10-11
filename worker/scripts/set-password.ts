// Rotates the admin password.
//
//   npm run set-password                  # prompt, hash, upload to Cloudflare
//   npm run set-password -- --print-only  # prompt, hash, print (upload by hand)
//
// The plaintext never reaches disk, a shell history, or a command line: it is
// read from the terminal with echo off and the hash is piped to
// `wrangler secret put` over stdin. Prompts go to stderr so that
// `--print-only > file` captures the hash and nothing else.

import { spawnSync } from "node:child_process";
import process from "node:process";
import { createInterface } from "node:readline/promises";

import { hashPassword } from "./hash-password.ts";

const SECRET_NAME = "PASSWORD_HASH";
const MIN_LENGTH = 12;

interface Reader {
  /** Reads one line, echoing neither it nor anything else to stdout. */
  prompt: (label: string) => Promise<string>;
  close: () => void;
}

/** Drains stdin in one go and splits it into lines. */
async function readPipedLines(): Promise<string[]> {
  process.stdin.setEncoding("utf8");
  const chunks: string[] = await Array.fromAsync(process.stdin as AsyncIterable<string>);
  return chunks.join("").split(/\r?\n/u);
}

/**
 * Two implementations, because readline is push-based: on a pipe every line
 * arrives at once, and a line emitted between two `question()` calls is simply
 * dropped. So a non-TTY stdin is drained up front and consumed a line at a
 * time, while a real terminal keeps interactive readline with its echo
 * suppressed.
 */
function createReader(): Reader {
  if (!process.stdin.isTTY) {
    // Say so rather than silently echoing a password the caller believed was
    // hidden. Normal for a pipe, and for Git Bash on Windows where TTY
    // detection is unreliable.
    console.error("! stdin is not a terminal; reading the password from stdin unmasked");

    let lines: string[] | undefined;
    return {
      prompt: async (label) => {
        lines ??= await readPipedLines();
        process.stderr.write(label);
        return (lines.shift() ?? "").trim();
      },
      close: () => {
        // Nothing to release: stdin was read to EOF.
      },
    };
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  return {
    prompt: async (label) => {
      // `terminal: true` echoes by default. Muting the output stream for the
      // duration of the read is the portable way to suppress it.
      const output = process.stderr;
      const originalWrite = output.write.bind(output);
      originalWrite(label);
      // Swallow readline's echo of the keystrokes, but let the trailing newline
      // through so the terminal still advances a line.
      output.write = (chunk: string) => !chunk.includes("\n") || originalWrite(chunk);
      try {
        const answer = await rl.question("");
        return answer.trim();
      } finally {
        output.write = originalWrite;
        originalWrite("\n");
      }
    },
    close: () => {
      rl.close();
    },
  };
}

const reader = createReader();

/** Prints a reason to stderr, releases stdin, and exits non-zero. */
function refuse(reason: string): never {
  reader.close();
  console.error(`Refusing: ${reason}`);
  process.exit(1);
}

const password = await reader.prompt("New admin password: ");
if (password.length < MIN_LENGTH) {
  refuse(`the admin password must be at least ${String(MIN_LENGTH)} characters.`);
}

const confirm = await reader.prompt("Confirm: ");
reader.close();

// Both sides are values this same operator typed a moment ago at this same
// terminal, so there is no attacker to leak a timing difference to.
// eslint-disable-next-line security/detect-possible-timing-attacks
if (confirm !== password) {
  refuse("the two entries did not match.");
}

const hash = hashPassword(password);

if (process.argv.includes("--print-only")) {
  console.log(hash);
  process.exit(0);
}

// `shell: true` is required on Windows, where wrangler is a .cmd shim that Node
// refuses to spawn directly (EINVAL).
const result = spawnSync("npx", ["wrangler", "secret", "put", SECRET_NAME], {
  input: hash,
  stdio: ["pipe", "inherit", "inherit"],
  shell: true,
});

if (result.error) {
  console.error(`Failed to run wrangler: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`wrangler secret put ${SECRET_NAME} exited with ${String(result.status)}`);
  process.exit(result.status ?? 1);
}

console.error(`${SECRET_NAME} updated.`);
