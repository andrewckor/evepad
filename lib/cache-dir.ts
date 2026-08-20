// The app's cache directory (~/.cache/evepad). The project shipped its first
// releases writing to ~/.cache/eve-cockpit; the old directory is adopted by a
// one-time rename so learned project paths and settings survive the rename.

import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

let migrated = false;

export function cacheDir(): string {
  const base = join(process.env.HOME ?? homedir(), ".cache");
  const dir = join(base, "evepad");
  if (!migrated) {
    migrated = true;
    const old = join(base, "eve-cockpit");
    try {
      if (!existsSync(dir) && existsSync(old)) renameSync(old, dir);
    } catch {}
  }
  return dir;
}
