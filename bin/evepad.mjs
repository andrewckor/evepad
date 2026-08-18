#!/usr/bin/env node
// evepad launcher: boot the prebuilt server and open it.
//
// The published package ships .next/standalone from `next build`, so this
// never installs or compiles anything — it starts `node server.js`, waits for
// the first 200, and opens the default browser. A second `evepad` finds the
// running instance and just opens the page: the port is FIXED by default so
// an installed PWA keeps pointing at the same app.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// Colour only when a terminal is watching, and never against NO_COLOR.
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const brand = (s) => paint("1;35", s);   // bold magenta, matching Next's own banner
const ok = (s) => paint("32", s);
const dim = (s) => paint("2", s);

const PORT = Number(opt("--port") ?? process.env.PORT ?? 4680);
const URL_ = `http://127.0.0.1:${PORT}/`;
const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

async function probe() {
  try {
    const r = await fetch(`${URL_}manifest.webmanifest`, { signal: AbortSignal.timeout(400) });
    if (!r.ok) return "other";
    const m = await r.json().catch(() => null);
    return m?.name === "evepad" ? "evepad" : "other";
  } catch {
    return "free";
  }
}

function openBrowser() {
  if (flag("--no-open")) return;
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  spawn(cmd, [URL_], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
}

const state = await probe();
if (state === "evepad") {
  // Already running — this launch is just a way back to the page.
  console.log(`\n  ${brand("\u25b2 evepad")} ${dim("\u2014 already running, opening it")}\n    ${ok("\u2713")} ${URL_}\n`);
  openBrowser();
  process.exit(0);
}
if (state === "other") {
  console.error(`Port ${PORT} is taken by something else — try: evepad --port 4681`);
  process.exit(1);
}

// `opencode` (and any other spawned tool) resolves from the install's .bin —
// the server's cwd is wherever the user ran `evepad`, which has no
// node_modules to look in.
const binDir = join(pkgDir, "..", ".bin");
const env = {
  ...process.env,
  PORT: String(PORT),
  HOSTNAME: "127.0.0.1",
  PATH: `${binDir}:${process.env.PATH ?? ""}`,
};

// The runtime version, read from the standalone tree we actually boot — the
// same number `next start` prints, from the same package.
let nextVersion = "";
try {
  nextVersion = JSON.parse(readFileSync(join(pkgDir, "standalone", "node_modules", "next", "package.json"), "utf8")).version;
} catch {}
console.log();
console.log(`  ${brand(`\u25b2 evepad${nextVersion ? ` \u00b7 Next.js ${nextVersion}` : ""}`)}`);
console.log(`    ${dim("\u2192")} starting server on :${PORT}\u2026`);

// Next prints its banner and ready lines to STDERR, not stdout — ignoring
// stdout alone left two voices in one terminal. So stderr is piped and the
// known banner lines are dropped; everything else passes through verbatim,
// because a real startup error must never be swallowed by a cosmetic filter.
const server = spawn(process.execPath, [join(pkgDir, "standalone", "server.js")], {
  env,
  cwd: pkgDir,
  stdio: ["ignore", "ignore", "pipe"],
});

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const BANNER = /^\s*(\u25b2\s*Next\.js|[-\u2022]\s*(Local|Network|Environments|Experiments)\b|\u2713\s*(Starting|Ready|Compiled))/;
let ready = false;
let tail = "";
server.stderr.on("data", (chunk) => {
  const lines = (tail + chunk.toString()).split("\n");
  tail = lines.pop() ?? "";
  for (const line of lines) {
    const plain = stripAnsi(line);
    // Before ready, drop Next's banner and the blank lines that frame it;
    // afterwards nothing is filtered at all.
    if (!ready && (BANNER.test(plain) || plain.trim() === "")) continue;
    process.stderr.write(line + "\n");
  }
});
server.on("exit", (code) => process.exit(code ?? 0));
// Ctrl-C escalates. Next shuts down gracefully — it drains open connections —
// and a dashboard tab always holds one (SSE, keep-alive polling), so a bare
// SIGTERM waits forever and Ctrl-C appears to do nothing. Give the graceful
// path 1.5s, then kill; a second Ctrl-C skips the wait entirely.
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (stopping) { server.kill("SIGKILL"); return; }
    stopping = true;
    console.log(`\n    ${dim("\u2192")} stopping evepad\u2026`);
    server.kill("SIGTERM");
    setTimeout(() => server.kill("SIGKILL"), 1500).unref();
  });
}

const t0 = Date.now();
for (;;) {
  if (await probe() === "evepad") break;
  if (Date.now() - t0 > 15_000) {
    console.error("evepad did not come up within 15s");
    server.kill();
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 40));
}
// Scoped to "server boot" on purpose: this timer starts when the bin does,
// and under npx the user has already paid npm's resolve/extract before that —
// a bare "(400ms)" reads as a lie next to their wall clock.
ready = true;
console.log();
console.log(`    ${ok("\u2713")} ready at ${URL_} ${dim(`(server boot ${Date.now() - t0}ms)`)}`);
if (!flag("--no-open")) {
  console.log(`    ${dim("\u2192")} opening your browser ${dim("\u2014 Ctrl-C here stops evepad")}`);
}
console.log();
openBrowser();
