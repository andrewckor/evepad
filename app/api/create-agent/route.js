// Create a brand-new eve agent end to end:
//   scaffold (eve init, GLM default) → Vercel project (link --yes creates it)
//   → AI Gateway creds (env pull) → register checkout → boot eve dev.
// Everything the user sees is one dialog; this route is the "behind the scenes".

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, openSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { remember } from "../../../lib/registry.js";

const exec = promisify(execFile);
const WORKSPACE = join(process.env.HOME ?? "/tmp", "eve-agents");
const LOG_DIR = join(process.env.HOME ?? "/tmp", ".cache", "eve-cockpit", "logs");
const NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;
const DEFAULT_MODEL = "zai/glm-5.2"; // free on AI Gateway through Aug 27

const isFree = (port) =>
  new Promise((res) => {
    const s = createServer().once("error", () => res(false)).once("listening", () => s.close(() => res(true))).listen(port, "127.0.0.1");
  });
async function freePort(start = 4200) {
  for (let p = start; p < start + 100; p++) if (await isFree(p)) return p;
  throw new Error("no free port");
}

export async function POST(request) {
  const { name, model } = await request.json();
  if (!NAME_RE.test(name ?? "")) return Response.json({ error: "Name must be kebab-case (a-z, 0-9, -)." }, { status: 400 });

  mkdirSync(WORKSPACE, { recursive: true });
  const dir = join(WORKSPACE, name);
  if (existsSync(dir)) return Response.json({ error: `~/eve-agents/${name} already exists.` }, { status: 409 });

  try {
    // 1. Scaffold. eve init installs dependencies itself.
    await exec("npx", ["--yes", "eve@latest", "init", name, "--model", model || DEFAULT_MODEL], {
      cwd: WORKSPACE, timeout: 420_000, maxBuffer: 32 << 20,
    });

    // 2. Vercel project: link --yes creates the project when it doesn't exist.
    await exec("vercel", ["link", "--yes", "--project", name], { cwd: dir, timeout: 90_000 });

    // 3. AI Gateway credentials (OIDC) for local dev.
    await exec("vercel", ["env", "pull", ".env.local", "--yes"], { cwd: dir, timeout: 60_000 });

    // 4. Register so pickers/play/build know the checkout immediately.
    remember(name, dir);

    // 5. Boot the dev server so the agent is live on arrival.
    const port = await freePort();
    mkdirSync(LOG_DIR, { recursive: true });
    const log = openSync(join(LOG_DIR, `${name}.log`), "a");
    const child = spawn("npm", ["exec", "--", "eve", "dev", "--no-ui", "--port", String(port)], {
      cwd: dir, detached: true, stdio: ["ignore", log, log],
      env: { ...process.env, EVE_TRACES_CONTENT: "on" },
    });
    child.unref();

    return Response.json({ ok: true, path: dir, port });
  } catch (e) {
    return Response.json({ error: `Create failed: ${String(e.message ?? e).slice(0, 300)}` }, { status: 502 });
  }
}
