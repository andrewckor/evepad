// App preferences that belong to the machine, not the browser. The workspace
// is the folder new agents are created in — it lives here rather than in
// localStorage because the SERVER is what writes into it.

import { readFileSync, writeFileSync, mkdirSync, statSync, accessSync, constants } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { cacheDir } from "./cache-dir";

const PATH = join(cacheDir(), "settings.json");
export const DEFAULT_WORKSPACE = join(homedir(), "eve-agents");

let mem: Record<string, unknown> | null = null;
let memMtime = 0;
function load(): Record<string, unknown> {
  // Same mtime-aware read as the registry: an out-of-band edit shows up on the
  // next read instead of surviving as stale in-process state.
  let mtime = 0;
  try {
    mtime = statSync(PATH).mtimeMs;
  } catch {}
  if (mem && mtime === memMtime) return mem;
  try {
    mem = JSON.parse(readFileSync(PATH, "utf8"));
  } catch {
    mem = {};
  }
  memMtime = mtime;
  return mem!;
}

export function getWorkspace(): string {
  const w = load().workspace;
  return typeof w === "string" && w ? w : DEFAULT_WORKSPACE;
}

// Why a workspace can't be used, or null. Checked BEFORE persisting: writing
// first and validating after left the app pointing at an unusable folder that
// every later create inherited.
export function workspaceError(dir: string | null | undefined): string | null {
  if (!dir || typeof dir !== "string") return "No folder given.";
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err.code === "EACCES" || err.code === "EPERM"
      ? `No permission to create ${dir}.`
      : `Can't use ${dir}: ${err.code ?? err.message}`;
  }
  try {
    if (!statSync(dir).isDirectory()) return `${dir} isn't a folder.`;
    accessSync(dir, constants.W_OK);
  } catch {
    return `No permission to write in ${dir}.`;
  }
  return null;
}

function save(next: Record<string, unknown>): void {
  mkdirSync(dirname(PATH), { recursive: true });
  writeFileSync(PATH, JSON.stringify(next, null, 2));
  mem = next;
  try {
    memMtime = statSync(PATH).mtimeMs;
  } catch {}
}

export function setWorkspace(dir: string): string {
  if (!dir || typeof dir !== "string") return getWorkspace();
  save({ ...load(), workspace: dir });
  return dir;
}

// Bash patterns the user answered "Always" to in Build chat. Machine-level on
// purpose: opencode remembers always-approvals per PROJECT, but in evepad the
// user treats them as one preference across agents — so they are also stored
// here and injected into every opencode server's boot config
// (lib/opencode.ts). Already-running servers pick them up on their next boot.
export function getPermissionAllows(): string[] {
  const v = load().permissionAllows;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];
}

export function addPermissionAllows(patterns: string[]): string[] {
  const clean = patterns.filter((p): p is string => typeof p === "string" && p !== "");
  const merged = [...new Set([...getPermissionAllows(), ...clean])];
  save({ ...load(), permissionAllows: merged });
  return merged;
}
