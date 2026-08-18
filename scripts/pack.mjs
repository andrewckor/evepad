// Assemble the publishable evepad package into dist/ and `npm pack` it.
//
// The package is the PREBUILT app: bin/ plus .next/standalone, so `npx evepad`
// downloads and runs — no build, no full dependency tree. Only two things
// can't ride inside the tarball and stay real dependencies:
//   node-pty     — native; installing it fresh gets the right platform binary
//                  (and its postinstall chmod), where the traced copy ships
//                  no prebuilds at all
//   opencode-ai  — a spawned binary, invisible to build tracing; its platform
//                  optional-deps mean users only download their own binary

import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

const root = process.cwd();
const app = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, "dist", "evepad");

// dev keeps writing to .next, so a build alongside it dies on a half-written
// manifest — after the whole compile, with nothing naming the cause.
const devPort = Number(/--port\s+(\d+)/.exec(app.scripts?.dev ?? "")?.[1] ?? 5173);
const inUse = (port) =>
  new Promise((res) => {
    const s = createConnection({ port, host: "127.0.0.1" })
      .once("connect", () => s.destroy(res(true)))
      .once("error", () => res(false));
  });

if (await inUse(devPort)) {
  console.error(`\n  The dev server is running on :${devPort}.`);
  console.error(`  Stop it first — a release build can't share .next with it.\n`);
  process.exit(1);
}

rmSync(join(root, ".next"), { recursive: true, force: true });

// --webpack: Turbopack externalises native addons under an internal id that
// doesn't resolve in standalone output, so node-pty terminals die at runtime.
execSync("npx next build --webpack", { stdio: "inherit" });

rmSync(join(root, "dist"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });

cpSync(join(root, ".next", "standalone"), join(out, "standalone"), { recursive: true });
// standalone expects static assets and public/ beside server.js; next build
// leaves both behind on purpose (they're normally a CDN's job).
cpSync(join(root, ".next", "static"), join(out, "standalone", ".next", "static"), { recursive: true });
cpSync(join(root, "public"), join(out, "standalone", "public"), { recursive: true });
// resolved from the package's own dependencies instead — see header.
// Turbopack traces opencode-ai in where webpack didn't: 137MB of binaries npm
// installs per-platform anyway.
for (const dep of ["node-pty", "opencode-ai"]) {
  rmSync(join(out, "standalone", "node_modules", dep), { recursive: true, force: true });
}
cpSync(join(root, "bin"), join(out, "bin"), { recursive: true });
// The npm page is the README — publishing without one shows an empty package.
cpSync(join(root, "README.md"), join(out, "README.md"));
// Apache-2.0 §4 requires both to travel with any distribution of the work.
cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
cpSync(join(root, "NOTICE"), join(out, "NOTICE"));

writeFileSync(join(out, "package.json"), JSON.stringify({
  name: "evepad",
  version: app.version,
  description: app.description ?? "Agent runs, local and remote",
  license: app.license,
  homepage: "https://github.com/andrewckor/evepad#readme",
  repository: { type: "git", url: "git+https://github.com/andrewckor/evepad.git" },
  bugs: { url: "https://github.com/andrewckor/evepad/issues" },
  keywords: ["eve", "vercel", "agents", "dashboard", "cli", "local"],
  bin: { evepad: "bin/evepad.mjs" },
  engines: { node: ">=20.9" },
  // npm strips the exec bit from node-pty's spawn-helper (same reason the
  // repo's own postinstall exists); resolved by path so hoisting can't break it.
  scripts: {
    postinstall: "node -e \"try{const{dirname,join}=require('path');const fs=require('fs');const p=join(dirname(require.resolve('node-pty/package.json')),'prebuilds');for(const d of fs.readdirSync(p)){try{fs.chmodSync(join(p,d,'spawn-helper'),0o755)}catch{}}}catch{}\"",
  },
  dependencies: {
    "opencode-ai": app.dependencies["opencode-ai"],
  },
  // node-pty ships prebuilds for darwin and win32 only; on Linux it compiles
  // with node-gyp, which needs python3/make/g++ and takes tens of seconds —
  // or fails outright in a slim container. As a hard dependency that failure
  // blocks the whole install. Optional means the dashboard installs and runs
  // everywhere, and only the embedded terminals degrade.
  optionalDependencies: {
    "node-pty": app.dependencies["node-pty"],
  },
}, null, 2));

execSync("npm pack --pack-destination ..", { cwd: out, stdio: "inherit" });
console.log("packed into dist/");
