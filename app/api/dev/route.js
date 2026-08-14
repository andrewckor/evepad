// Start/stop a project's local `eve dev` server from the dashboard.
//
// start: spawns `npm exec -- eve dev --no-ui` detached in the project's checkout
//        (path from live detection or the registry), on a free port, logging to
//        ~/.cache/eve-cockpit/logs/<name>.log. Returns once /eve/v1/health answers.
// stop:  kills whatever is listening on the server's port — but only after
//        verifying it actually answers /eve/v1/info, so we never kill a stranger.

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { openSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { resolveProject } from "../../../lib/projects.js";
import { remember } from "../../../lib/registry.js";

const exec = promisify(execFile);
const LOG_DIR = join(process.env.HOME ?? "/tmp", ".cache", "eve-cockpit", "logs");

const isFree = (port) =>
  new Promise((res) => {
    const s = createServer()
      .once("error", () => res(false))
      .once("listening", () => s.close(() => res(true)))
      .listen(port, "127.0.0.1");
  });

async function freePort(start = 4200) {
  for (let p = start; p < start + 100; p++) if (await isFree(p)) return p;
  throw new Error("no free port in 4200-4299");
}

const health = async (port, ms = 1500) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/eve/v1/health`, { signal: ctrl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
};

export async function POST(request) {
  const { project: name, action } = await request.json();
  const project = await resolveProject(name);
  if (!project) return Response.json({ error: "unknown project" }, { status: 404 });

  if (action === "start") {
    if (project.live) return Response.json({ ok: true, port: project.localPort, already: true });
    if (!project.localPath)
      return Response.json(
        { error: "No known checkout for this project. Run `eve dev` in it once so the cockpit learns its path." },
        { status: 409 },
      );

    // Self-heal the checkout before spawning:
    // - Without its own node_modules/eve, `npm exec` downloads LATEST eve and runs
    //   it against an agent written for an older API — "Failed to evaluate
    //   authored module". Installing makes the checkout's pinned version win.
    // - Without .env.local the server boots but every model call fails on creds.
    const needsInstall = !existsSync(join(project.localPath, "node_modules", "eve"));
    if (needsInstall) {
      try {
        await exec("npm", ["install", "--no-audit", "--no-fund"], {
          cwd: project.localPath,
          timeout: 300_000,
          maxBuffer: 16 << 20,
        });
      } catch (e) {
        return Response.json(
          { error: `npm install failed in ${project.localPath}: ${String(e.message).slice(0, 200)}` },
          { status: 502 },
        );
      }
    }
    if (!existsSync(join(project.localPath, ".env.local"))) {
      try {
        // A checkout picked via the folder dialog may not be linked yet — env pull
        // needs the link to resolve credentials. Linking an existing project only
        // writes ids locally; it creates nothing on Vercel.
        if (!existsSync(join(project.localPath, ".vercel", "project.json")) && project.id) {
          await exec("vercel", ["link", "--yes", "--project", project.name], {
            cwd: project.localPath,
            timeout: 60_000,
          });
        }
        await exec("vercel", ["env", "pull", ".env.local", "--yes"], { cwd: project.localPath, timeout: 60_000 });
      } catch {} // creds are fixable later; don't block the boot on this
    }

    const port = await freePort();
    mkdirSync(LOG_DIR, { recursive: true });
    const log = openSync(join(LOG_DIR, `${project.name}.log`), "a");
    const child = spawn("npm", ["exec", "--", "eve", "dev", "--no-ui", "--port", String(port)], {
      cwd: project.localPath,
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, EVE_TRACES_CONTENT: "on" },
    });
    child.unref();

    // eve dev typically answers within a few seconds; give it 25 to cover a cold
    // compile, and report the log path on failure instead of guessing.
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if (await health(port)) return Response.json({ ok: true, port });
      await new Promise((r) => setTimeout(r, 700));
    }
    // Include the log tail so the alert says WHY, not just where to look.
    let tail = "";
    try {
      tail = readFileSync(join(LOG_DIR, `${project.name}.log`), "utf8").trim().split("\n").slice(-4).join("\n");
    } catch {}
    return Response.json(
      { error: `Server did not become healthy on :${port}.\n\n${tail}\n\n(full log: ~/.cache/eve-cockpit/logs/${project.name}.log)` },
      { status: 502 },
    );
  }

  if (action === "stop") {
    if (!project.live || !project.localPort)
      return Response.json({ ok: true, already: true });
    // Identity check before killing anything on the port.
    if (!(await health(project.localPort)))
      return Response.json({ error: "Port did not answer as an eve server; not killing it." }, { status: 409 });
    const { stdout } = await exec("lsof", ["-t", `-iTCP:${project.localPort}`, "-sTCP:LISTEN"]);
    const pids = stdout.split("\n").map((s) => Number(s.trim())).filter(Boolean);
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    return Response.json({ ok: true, stopped: pids.length });
  }

  // Connect a checkout: open the native macOS folder picker (the server runs on
  // the user's machine, so this beats a browser file input — those can't return
  // absolute paths), validate the choice, and remember it in the registry.
  if (action === "locate") {
    let picked;
    try {
      const { stdout } = await exec(
        "osascript",
        ["-e", `POSIX path of (choose folder with prompt "Select the checkout for ${project.name}")`],
        { timeout: 120_000 },
      );
      picked = stdout.trim().replace(/\/$/, "");
    } catch (e) {
      // Exit 1 with "User canceled" is the normal cancel path, not an error.
      if (String(e.stderr ?? e.message).includes("canceled")) return Response.json({ ok: false, cancelled: true });
      return Response.json({ error: "Could not open the folder picker." }, { status: 500 });
    }

    // Must look like an eve project: an agent/ dir, or package.json depending on eve.
    let isEve = existsSync(join(picked, "agent"));
    if (!isEve) {
      try {
        const pkg = JSON.parse(readFileSync(join(picked, "package.json"), "utf8"));
        isEve = Boolean(pkg.dependencies?.eve ?? pkg.devDependencies?.eve);
      } catch {}
    }
    if (!isEve)
      return Response.json(
        { error: `${picked} doesn't look like an eve project (no agent/ directory and no eve dependency).` },
        { status: 422 },
      );

    // If the checkout is linked to a Vercel project, it must be THIS one — a
    // mismatched link would silently show one project's runs under another's name.
    const linkPath = join(picked, ".vercel", "project.json");
    if (project.id && existsSync(linkPath)) {
      try {
        const link = JSON.parse(readFileSync(linkPath, "utf8"));
        if (link.projectId && link.projectId !== project.id)
          return Response.json(
            { error: `That folder is linked to "${link.projectName}", not "${project.name}".` },
            { status: 422 },
          );
      } catch {}
    }

    remember(project.name, picked);
    return Response.json({ ok: true, path: picked });
  }

  return Response.json({ error: "action must be start, stop, or locate" }, { status: 400 });
}
