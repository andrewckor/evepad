// One-time discovery for stopped local agents.
//
// Live discovery remains the fast source of truth. Discovery walks the
// current user's files in the background, prunes dependency/build trees, and
// remembers eve checkouts in the existing registry. The completion marker
// makes later launches free — it re-runs only when something real changed:
// a machine that never scanned, a different login (each `vercel login`
// mints a new token), or a SCAN_VERSION bump because the scan itself
// learned new structure. An ordinary version update stays quiet.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { cacheDir } from "./cache-dir";
import { remember } from "./registry";
import { cliToken } from "./projects";
import { discoveredAgentName, isEveAgentPackage, type PackageJson } from "./local-discovery-utils";

const MARKER = join(cacheDir(), "local-discovery-v1.json");
// Bump ONLY when the scan learns new structure (new markers to look for, new
// fields recorded) and one machine-wide re-scan is worth the intro screen.
// Markers written before this field existed fail the check and re-scan once.
const SCAN_VERSION = 1;

// The session, not the person: every `vercel login` mints a fresh token, so
// a logout/login re-runs discovery even for the same account.
function sessionFingerprint(): string | null {
  const token = cliToken();
  return token ? createHash("sha256").update(token).digest("hex").slice(0, 16) : null;
}
const PRUNED_DIRS = [
  "Library",
  "node_modules",
  ".git",
  ".next",
  ".cache",
  ".Trash",
  ".turbo",
  ".pnpm-store",
  "dist",
  "build",
  "coverage",
];

let running = false;
let foundCount: number | null = null;

function eveRoots(root: string): Promise<string[]> {
  return new Promise((resolve) => {
    const prune: string[] = [];
    PRUNED_DIRS.forEach((name, i) => {
      if (i) prune.push("-o");
      prune.push("-name", name);
    });
    const child = spawn(
      "/usr/bin/find",
      [
        root,
        "-xdev",
        "(",
        "-type",
        "d",
        "(",
        ...prune,
        ")",
        "-prune",
        ")",
        "-o",
        "-type",
        "d",
        "-name",
        ".eve",
        "-print0",
        "-prune",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => resolve([]));
    child.on("close", () => {
      const output = Buffer.concat(chunks).toString("utf8");
      resolve(output.split("\0").filter(Boolean));
    });
  });
}

async function inspectCandidate(root: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as PackageJson;
    if (!isEveAgentPackage(pkg)) return false;

    let linkedName: unknown;
    try {
      linkedName = JSON.parse(
        readFileSync(join(root, ".vercel", "project.json"), "utf8"),
      ).projectName;
    } catch {}
    const name = discoveredAgentName(pkg, basename(root), linkedName);
    if (!name) return false;
    remember(name, root);
    return true;
  } catch {
    return false;
  }
}

async function discover(root: string, fingerprint: string): Promise<void> {
  running = true;
  try {
    // A single `find $HOME` walks every top-level tree serially. Split those
    // trees into small parallel batches instead; this keeps I/O bounded while
    // making the one-time scan substantially faster on SSDs.
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const searchRoots = entries
      // Hidden top-level folders are tool state (`.codex`, `.cursor`, caches,
      // runtimes), not user project roots. Walking them dominated scan time.
      // We still search for the hidden `.eve` marker inside normal folders.
      .filter(
        (entry) =>
          entry.isDirectory() && !entry.name.startsWith(".") && !PRUNED_DIRS.includes(entry.name),
      )
      .map((entry) => join(root, entry.name));
    const roots: string[] = [];
    for (let i = 0; i < searchRoots.length; i += 6) {
      const matches = await Promise.all(searchRoots.slice(i, i + 6).map(eveRoots));
      roots.push(...matches.flat());
    }
    let found = 0;
    // Keep filesystem pressure predictable on machines with many repositories.
    for (let i = 0; i < roots.length; i += 8) {
      const results = await Promise.all(
        roots.slice(i, i + 8).map((eveDir) => inspectCandidate(dirname(eveDir))),
      );
      found += results.filter(Boolean).length;
    }
    foundCount = found;
    try {
      mkdirSync(dirname(MARKER), { recursive: true });
      writeFileSync(
        MARKER,
        JSON.stringify({
          completedAt: new Date().toISOString(),
          root,
          found,
          scanVersion: SCAN_VERSION,
          session: fingerprint,
        }),
      );
    } catch {}
  } finally {
    running = false;
  }
}

// No started-once latch: `running` already prevents overlap (discover sets it
// synchronously), and a completed scan writes the marker that makes
// isLocalAgentDiscoveryNeeded() false — while a login change mid-process must
// be able to start a second scan.
export function startLocalAgentDiscovery(): void {
  const fp = sessionFingerprint();
  if (!fp || running || !isLocalAgentDiscoveryNeeded()) return;
  void discover(process.env.HOME || homedir(), fp);
}

export function isLocalAgentDiscoveryRunning(): boolean {
  return running;
}

export function localAgentDiscoveryFoundCount(): number | null {
  return foundCount;
}

export function isLocalAgentDiscoveryNeeded(): boolean {
  // Signed out never scans — authentication gates the page anyway, and a
  // scan attributed to nobody would suppress the post-login one.
  const fp = sessionFingerprint();
  if (!fp) return false;
  try {
    const m = JSON.parse(readFileSync(MARKER, "utf8")) as {
      scanVersion?: unknown;
      session?: unknown;
    };
    return m.scanVersion !== SCAN_VERSION || m.session !== fp;
  } catch {
    return true; // no marker (or unreadable): a machine that never scanned
  }
}
