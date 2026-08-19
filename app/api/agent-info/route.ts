// The agent's static shape (tools, channels, schedules, model, diagnostics)
// straight from `eve info --json` — the same manifest the compiler builds.
// Cached briefly: info compiles the agent and costs a few seconds.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProject, eveVersionAt } from "@/lib/projects";
import { errMsg } from "@/lib/utils";

const exec = promisify(execFile);
const cache = new Map<string, { at: number; data: Record<string, unknown> }>(); // name -> {at, data}
const compiling = new Map<string, Promise<unknown>>();
const failed = new Map<string, { at: number; message: string }>();
const TTL = 10_000;

// Extracted so the route can run it in the background and answer immediately.
import type { Project } from "@/lib/types";

async function compile(project: Project) {
  // `npm exec` spends hundreds of ms resolving before eve even starts — call
  // the project-local bin directly when it exists.
  const eveBin = join(project.localPath ?? "", "node_modules", ".bin", "eve");
  const [cmd, args] = existsSync(eveBin)
    ? [eveBin, ["info", "--json"]]
    : ["npm", ["exec", "--", "eve", "info", "--json"]];
  const { stdout } = await exec(cmd, args as string[], {
    cwd: project.localPath ?? undefined,
    timeout: 120_000,
    maxBuffer: 16 << 20,
  });
  const info = JSON.parse(stdout.slice(stdout.indexOf("{")));
  const byChannel = new Map();
  for (const c of info.channels ?? []) {
    const key = `${c.name}:${c.kind}`;
    if (!byChannel.has(key)) byChannel.set(key, { name: c.name, kind: c.kind, routes: 0 });
    byChannel.get(key).routes += 1;
  }
  return {
    name: info.agent?.name ?? info.name ?? project.name,
    model: info.model ?? info.agent?.model?.id ?? null,
    instructions: info.instructions ?? null,
    skills: info.skills ?? [],
    subagents: info.subagents ?? [],
    channels: [...byChannel.values()],
    diagnostics: info.diagnostics ?? null,
    eveVersion: eveVersionAt(project.localPath),
  };
}

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const name = new URL(request.url).searchParams.get("project") ?? "";
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  const project = await resolveProject(name);
  if (!project?.localPath) return Response.json({ error: "No local checkout." }, { status: 409 });
  // Narrowing doesn't survive into the closures below (localPath is a mutable
  // property), so pin it once.
  const root = project.localPath;

  // Tool names are read live from disk on EVERY call — a readdir is free, and
  // it makes the graph track edits from any source (chat, terminal, editor)
  // in near-real-time without recompiling the agent.
  const liveTools = () => {
    try {
      return readdirSync(join(root, "agent", "tools"))
        .filter((f) => /\.(ts|js)$/.test(f))
        .map((f) => f.replace(/\.(ts|js)$/, ""))
        .sort();
    } catch {
      return [];
    }
  };
  // Schedules read live too, with their cron pulled from the source — eve info
  // reports only names.
  const liveSchedules = () => {
    try {
      return readdirSync(join(root, "agent", "schedules"))
        .filter((f) => /\.(ts|js)$/.test(f))
        .map((f) => {
          const name = f.replace(/\.(ts|js)$/, "");
          let cron = null;
          try {
            cron =
              readFileSync(join(root, "agent", "schedules", f), "utf8").match(
                /cron:\s*['"`]([^'"`]+)['"`]/,
              )?.[1] ?? null;
          } catch {}
          return { name, cron };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  };

  // Connections, live from disk like tools and schedules — `eve info --json`
  // doesn't report them at all, which is why the graph always said 0.
  //
  // They come from two places, and Vercel counts both:
  //   agent/connections/<name>.ts                     -> "<name>"
  //   agent/extensions/<ext>/connections/<name>.ts    -> "<ext>__<name>"
  // An extension's connections usually ship inside its npm package; a local
  // file of the same name SHADOWS the packaged one rather than adding to it
  // (a common way to extend a packaged connection's arguments),
  // so the two sources are unioned by name, not summed.
  const dirNames = (dir: string): string[] => {
    try {
      return readdirSync(dir)
        .filter((f) => /\.(ts|js|mjs)$/.test(f) && !f.endsWith(".d.ts"))
        .map((f) => f.replace(/\.(ts|js|mjs)$/, ""));
    } catch {
      return [];
    }
  };
  const liveConnections = () => {
    const out = new Set(dirNames(join(root, "agent", "connections")));
    let exts: string[] = [];
    try {
      exts = readdirSync(join(root, "agent", "extensions"), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {}
    for (const ext of exts) {
      const base = join(root, "agent", "extensions", ext);
      const names = new Set(dirNames(join(base, "connections")));
      // The package the extension wraps, from its own import line.
      let pkg: string | null = null;
      for (const f of ["extension.ts", "extension.js"]) {
        try {
          pkg =
            readFileSync(join(base, f), "utf8").match(/from\s+["']([^"'.][^"']*)["']/)?.[1] ?? null;
          if (pkg) break;
        } catch {}
      }
      if (pkg) {
        for (const sub of ["dist/extension/connections", "extension/connections"]) {
          const found = dirNames(join(root, "node_modules", pkg, sub));
          if (found.length) {
            found.forEach((n) => names.add(n));
            break;
          }
        }
      }
      for (const n of names) out.add(`${ext}__${n}`);
    }
    return [...out].sort();
  };

  const hit = cache.get(project.name);
  const stale = fresh || !hit || Date.now() - hit.at >= TTL * 6;

  // Compiles ALWAYS run in the background — an inline `eve info` holds one of
  // the browser's six HTTP/1.1 slots for the whole compile. Callers get the
  // last snapshot (with live disk reads) and compiling:true until the new one
  // lands; the client's poll picks it up.
  if (stale && !compiling.has(project.name)) {
    const p = compile(project)
      .then((data) => {
        cache.set(project.name, { at: Date.now(), data });
        failed.delete(project.name);
      })
      .catch((e) => failed.set(project.name, { at: Date.now(), message: errMsg(e).slice(0, 250) }))
      .finally(() => compiling.delete(project.name));
    compiling.set(project.name, p);
  }

  const live = {
    tools: liveTools(),
    schedules: liveSchedules(),
    connections: liveConnections(),
  };
  if (hit)
    return Response.json({
      ...hit.data,
      ...live,
      ...(compiling.has(project.name) ? { compiling: true } : {}),
    });
  const err = failed.get(project.name);
  if (err && Date.now() - err.at < 10_000)
    return Response.json({ error: `eve info failed: ${err.message}` }, { status: 502 });
  return Response.json({ compiling: true, ...live }, { status: 202 });
}
