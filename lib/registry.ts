// Persistent project-path registry.
//
// Discovery can only see *running* eve dev servers, so the first time a project
// is observed live we remember where its checkout lives. That memory is what
// keeps a stopped project on the Agents page (with its play button) and lets
// the local adapter read its .eve store.
//
// Each entry also records the checkout's Vercel org (from .vercel/project.json)
// so visibility can be scoped to the CURRENT login: another user's session on
// this machine doesn't see your linked projects, and logging back in shows
// them again — the ownership check is live, never a stored flag that can go
// stale. Unlinked checkouts carry no org and are machine-local by nature.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { cacheDir } from "./cache-dir";

const REG_PATH = join(cacheDir(), "registry.json");

type RegistryEntry = {
  path: string;
  orgId: string | null;
  projectId: string | null;
  lastSeenAt?: string | null;
};
export type KnownProject = RegistryEntry & { name: string };

let mem: Record<string, RegistryEntry> | null = null;
let memMtime = 0;
function load(): Record<string, RegistryEntry> {
  // mtime-aware: out-of-band edits (another process, manual cleanup) are
  // picked up on the next read instead of surviving as stale in-process state.
  let mtime = 0;
  try {
    mtime = statSync(REG_PATH).mtimeMs;
  } catch {}
  if (mem && mtime === memMtime) return mem;
  try {
    mem = JSON.parse(readFileSync(REG_PATH, "utf8"));
  } catch {
    mem = {};
  }
  memMtime = mtime;
  return mem!;
}

function save(reg: Record<string, RegistryEntry>) {
  try {
    mkdirSync(dirname(REG_PATH), { recursive: true });
    writeFileSync(REG_PATH, JSON.stringify(reg, null, 2));
    try {
      memMtime = statSync(REG_PATH).mtimeMs;
    } catch {}
  } catch {}
}

function linkOf(path: string): { orgId: string | null; projectId: string | null } {
  try {
    const link = JSON.parse(readFileSync(join(path, ".vercel", "project.json"), "utf8"));
    return { orgId: link.orgId ?? null, projectId: link.projectId ?? null };
  } catch {
    return { orgId: null, projectId: null };
  }
}

export function knownPath(name: string): string | null {
  const p = load()[name]?.path;
  return p && existsSync(p) ? p : null;
}

export function knows(name: string): boolean {
  return Boolean(knownPath(name));
}

export function remember(name: string, path: string) {
  if (!name || !path) return;
  const reg = load();
  const { orgId, projectId } = linkOf(path);
  const prev = reg[name];
  if (prev?.path === path && prev?.orgId === orgId) return;
  reg[name] = { path, orgId, projectId, lastSeenAt: new Date().toISOString() };
  save(reg);
}

// Every remembered project whose checkout still exists. Vanished paths are
// pruned on read so the registry can't serve stale entries. The org link is
// re-read from disk each time — relinking a checkout updates ownership
// without any evepad bookkeeping.
// Drop a mapping — the folder moved, or it was pointed at the wrong one.
// The project itself is untouched; only this machine forgets where it is.
export function forget(name: string): boolean {
  const reg = load();
  if (!reg[name]) return false;
  delete reg[name];
  save(reg);
  return true;
}

export function allKnown(): KnownProject[] {
  const reg = load();
  let dirty = false;
  const out: KnownProject[] = [];
  for (const [name, e] of Object.entries(reg)) {
    if (!e?.path || !existsSync(e.path)) {
      delete reg[name];
      dirty = true;
      continue;
    }
    const { orgId, projectId } = linkOf(e.path);
    if (orgId !== e.orgId || projectId !== e.projectId) {
      reg[name] = { ...e, orgId, projectId };
      dirty = true;
    }
    out.push({ name, path: e.path, orgId, projectId, lastSeenAt: e.lastSeenAt ?? null });
  }
  if (dirty) save(reg);
  return out;
}
