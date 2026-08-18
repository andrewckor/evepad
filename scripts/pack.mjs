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
import { join } from "node:path";

const root = process.cwd();
const app = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, "dist", "evepad");

execSync("npx next build", { stdio: "inherit" });

rmSync(join(root, "dist"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });

cpSync(join(root, ".next", "standalone"), join(out, "standalone"), { recursive: true });
// standalone expects static assets and public/ beside server.js; next build
// leaves both behind on purpose (they're normally a CDN's job).
cpSync(join(root, ".next", "static"), join(out, "standalone", ".next", "static"), { recursive: true });
cpSync(join(root, "public"), join(out, "standalone", "public"), { recursive: true });
// resolved from the package's own dependencies instead — see header.
rmSync(join(out, "standalone", "node_modules", "node-pty"), { recursive: true, force: true });
cpSync(join(root, "bin"), join(out, "bin"), { recursive: true });

writeFileSync(join(out, "package.json"), JSON.stringify({
  name: "evepad",
  version: app.version,
  description: app.description ?? "Agent runs, local and remote",
  license: app.license,
  bin: { evepad: "bin/evepad.mjs" },
  engines: { node: ">=20.9" },
  // npm strips the exec bit from node-pty's spawn-helper (same reason the
  // repo's own postinstall exists); resolved by path so hoisting can't break it.
  scripts: {
    postinstall: "node -e \"const{dirname,join}=require('path');const fs=require('fs');const p=join(dirname(require.resolve('node-pty/package.json')),'prebuilds');for(const d of fs.readdirSync(p)){try{fs.chmodSync(join(p,d,'spawn-helper'),0o755)}catch{}}\"",
  },
  dependencies: {
    "node-pty": app.dependencies["node-pty"],
    "opencode-ai": app.dependencies["opencode-ai"],
  },
}, null, 2));

execSync("npm pack --pack-destination ..", { cwd: out, stdio: "inherit" });
console.log("packed into dist/");
