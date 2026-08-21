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

export function setWorkspace(dir: string): string {
  if (!dir || typeof dir !== "string") return getWorkspace();
  const next = { ...load(), workspace: dir };
  writeSettings(next);
  return dir;
}

// Failure-alert webhook. Empty string clears it; anything non-http(s) is
// rejected here so the alert relay never becomes a fetch of some odd scheme.
export function getAlertWebhook(): string {
  const w = load().alertWebhook;
  return typeof w === "string" ? w : "";
}

export function setAlertWebhook(url: string): string | null {
  const v = typeof url === "string" ? url.trim() : "";
  if (v && !/^https?:\/\//i.test(v)) return "Webhook must be an http(s) URL.";
  writeSettings({ ...load(), alertWebhook: v });
  return null;
}

function writeSettings(next: Record<string, unknown>): void {
  mkdirSync(dirname(PATH), { recursive: true });
  writeFileSync(PATH, JSON.stringify(next, null, 2));
  mem = next;
  try {
    memMtime = statSync(PATH).mtimeMs;
  } catch {}
}
