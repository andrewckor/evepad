// App preferences that belong to the machine, not the browser. The workspace
// is the folder new agents are created in — it lives here rather than in
// localStorage because the SERVER is what writes into it.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, accessSync, constants } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const PATH = join(homedir(), ".cache", "eve-cockpit", "settings.json");
export const DEFAULT_WORKSPACE = join(homedir(), "eve-agents");

let mem = null;
let memMtime = 0;
function load() {
  // Same mtime-aware read as the registry: an out-of-band edit shows up on the
  // next read instead of surviving as stale in-process state.
  let mtime = 0;
  try { mtime = statSync(PATH).mtimeMs; } catch {}
  if (mem && mtime === memMtime) return mem;
  try { mem = JSON.parse(readFileSync(PATH, "utf8")); } catch { mem = {}; }
  memMtime = mtime;
  return mem;
}

export function getWorkspace() {
  const w = load().workspace;
  return typeof w === "string" && w ? w : DEFAULT_WORKSPACE;
}

// Why a workspace can't be used, or null. Checked BEFORE persisting: writing
// first and validating after left the app pointing at an unusable folder that
// every later create inherited.
export function workspaceError(dir) {
  if (!dir || typeof dir !== "string") return "No folder given.";
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return e.code === "EACCES" || e.code === "EPERM"
      ? `No permission to create ${dir}.`
      : `Can't use ${dir}: ${e.code ?? e.message}`;
  }
  try {
    if (!statSync(dir).isDirectory()) return `${dir} isn't a folder.`;
    accessSync(dir, constants.W_OK);
  } catch {
    return `No permission to write in ${dir}.`;
  }
  return null;
}

export function setWorkspace(dir) {
  if (!dir || typeof dir !== "string") return getWorkspace();
  const next = { ...load(), workspace: dir };
  mkdirSync(dirname(PATH), { recursive: true });
  writeFileSync(PATH, JSON.stringify(next, null, 2));
  mem = next;
  try { memMtime = statSync(PATH).mtimeMs; } catch {}
  return dir;
}

// Created on demand, not at read time: the folder shouldn't exist just because
// someone opened Settings. Never throws — callers use it for a picker's
// starting point and a failure there must not take the request down.
export function ensureWorkspace() {
  const w = getWorkspace();
  try { mkdirSync(w, { recursive: true }); } catch {}
  return existsSync(w) ? w : null;
}
