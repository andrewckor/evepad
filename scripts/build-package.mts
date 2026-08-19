// Build the publishable evepad package into dist/ and `npm pack` it.
//
// What ships is the prebuilt app — bin/ plus .next/standalone — so `npx evepad`
// runs without compiling anything. node-pty is the exception: a native addon,
// so it stays a (optional) dependency and npm fetches the right prebuild.
// opencode is NOT a dependency — its platform binary is 143MB, ~90% of the
// old install. Build chat runs a managed, version-pinned copy npm-installed
// into ~/.evepad in the background on first boot (see lib/opencode.ts), so
// `npx evepad` stays one command with nothing blocking on the download.

import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

const root = process.cwd();
const app = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// The launcher needs the pinned opencode version to tell a cold run (long
// first boot, say why) from a warm one. lib/opencode.ts owns the pin; fail
// loudly if it ever moves.
const opencodeVersion = /OPENCODE_VERSION = "([^"]+)"/.exec(
  readFileSync(join(root, "lib", "opencode.ts"), "utf8"),
)?.[1];
if (!opencodeVersion) throw new Error("OPENCODE_VERSION not found in lib/opencode.ts");
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
cpSync(join(root, ".next", "static"), join(out, "standalone", ".next", "static"), {
  recursive: true,
});
cpSync(join(root, "public"), join(out, "standalone", "public"), { recursive: true });
// Never bundled — see header. Belt and braces: webpack leaves them alone, but
// Turbopack traced 137MB of every-platform binaries in.
for (const dep of ["node-pty", "opencode-ai"]) {
  rmSync(join(out, "standalone", "node_modules", dep), { recursive: true, force: true });
}
cpSync(join(root, "bin"), join(out, "bin"), { recursive: true });
// The npm page carries its own title and version, so the centred logo and
// badges are repo furniture — swap the whole block for a plain heading and
// drop the repo-only sections. Generated, not a second file that could drift.
writeFileSync(
  join(out, "README.md"),
  readFileSync(join(root, "README.md"), "utf8")
    .replace(/<div align="center">[\s\S]*?<\/div>\n\n/, "# evepad\n\n")
    .replace(/<!-- npm:skip -->[\s\S]*?<!-- \/npm:skip -->\n/g, ""),
);
// Apache-2.0 §4 requires both to travel with any distribution of the work.
cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
cpSync(join(root, "NOTICE"), join(out, "NOTICE"));

writeFileSync(
  join(out, "package.json"),
  JSON.stringify(
    {
      name: "evepad",
      version: app.version,
      description: app.description,
      license: app.license,
      homepage: "https://github.com/andrewckor/evepad#readme",
      repository: { type: "git", url: "git+https://github.com/andrewckor/evepad.git" },
      bugs: { url: "https://github.com/andrewckor/evepad/issues" },
      keywords: ["eve", "vercel", "agents", "dashboard", "cli", "local"],
      bin: { evepad: "bin/evepad.mjs" },
      opencodeVersion,
      engines: { node: ">=24" },
      // npm strips the exec bit from node-pty's spawn-helper; resolved by path so
      // hoisting can't move it out from under us.
      scripts: {
        // This manifest is the one that gets published; the repo's own is private.
        // If it is ever run from the wrong directory, say so instead of shipping.
        prepublishOnly:
          "node -e \"if(!require('fs').existsSync('./standalone/server.js'))throw new Error('run npm run pack — do not publish from the repo root')\"",
        postinstall:
          "node -e \"try{const{dirname,join}=require('path');const fs=require('fs');const p=join(dirname(require.resolve('node-pty/package.json')),'prebuilds');for(const d of fs.readdirSync(p)){try{fs.chmodSync(join(p,d,'spawn-helper'),0o755)}catch{}}}catch{}\"",
      },
      // Optional: node-pty has no Linux prebuild, and a compile failure there
      // should cost you the terminals, not the whole install.
      optionalDependencies: {
        "node-pty": app.dependencies["node-pty"],
      },
    },
    null,
    2,
  ),
);

execSync("npm pack --pack-destination ..", { cwd: out, stdio: "inherit" });
console.log("packed into dist/");
