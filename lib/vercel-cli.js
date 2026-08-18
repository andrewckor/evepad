// How every spawn of the Vercel CLI resolves it. With the CLI installed it
// runs directly; without it, through npx — which ships with Node, so a packed
// evepad has no prerequisite beyond Node itself. The first npx run downloads
// the CLI (one-time, cached); the natural first touch is the sign-in
// terminal, which has no timeout to trip.

import { accessSync, constants } from "node:fs";
import { join, delimiter } from "node:path";

let resolved;

export function vercelCommand() {
  if (resolved) return resolved;
  const hit = (process.env.PATH ?? "").split(delimiter).some((dir) => {
    if (!dir) return false;
    try { accessSync(join(dir, "vercel"), constants.X_OK); return true; } catch { return false; }
  });
  resolved = hit ? ["vercel"] : ["npx", "--yes", "vercel"];
  return resolved;
}
