// Background discovery of stopped local agents, fed into the registry.
// Re-runs only for a never-scanned machine, a new login session, or a
// SCAN_VERSION bump — ordinary version updates stay quiet.

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
// Bump ONLY when the scan learns new structure and a re-scan is worth it.
const SCAN_VERSION = 1;

// Every `vercel login` mints a fresh token — logout/login re-scans.
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

// No started-once latch: `running` prevents overlap, the marker ends
// re-runs, and a mid-process login change must be able to scan again.
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
  // Signed out never scans — auth gates the page anyway.
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
