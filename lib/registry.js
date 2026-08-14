// Persistent project-path registry.
//
// Discovery can only see *running* eve dev servers, so the first time a project
// is observed live we remember where its checkout lives. That memory is what
// makes the play button possible after the server stops — and lets the local
// adapter read a stopped project's .eve store.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const REG_PATH = join(process.env.HOME ?? "/tmp", ".cache", "eve-cockpit", "registry.json");

let mem = null;
function load() {
  if (mem) return mem;
  try { mem = JSON.parse(readFileSync(REG_PATH, "utf8")); } catch { mem = {}; }
  return mem;
}

export function knownPath(name) {
  const p = load()[name]?.path;
  return p && existsSync(p) ? p : null;
}

export function remember(name, path) {
  if (!name || !path) return;
  const reg = load();
  if (reg[name]?.path === path) return;
  reg[name] = { path, lastSeenAt: new Date().toISOString() };
  try {
    mkdirSync(dirname(REG_PATH), { recursive: true });
    writeFileSync(REG_PATH, JSON.stringify(reg, null, 2));
  } catch {}
}
