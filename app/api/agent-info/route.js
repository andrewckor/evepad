// The agent's static shape (tools, channels, schedules, model, diagnostics)
// straight from `eve info --json` — the same manifest the compiler builds.
// Cached briefly: info compiles the agent and costs a few seconds.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProject } from "../../../lib/projects.js";

const exec = promisify(execFile);
const cache = new Map(); // name -> {at, data}
const TTL = 10_000;

export const dynamic = "force-dynamic";

export async function GET(request) {
  const name = new URL(request.url).searchParams.get("project") ?? "";
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  const project = await resolveProject(name);
  if (!project?.localPath) return Response.json({ error: "No local checkout." }, { status: 409 });

  // Tool names are read live from disk on EVERY call — a readdir is free, and
  // it makes the graph track edits from any source (chat, terminal, editor)
  // in near-real-time without recompiling the agent.
  const liveTools = () => {
    try {
      return readdirSync(join(project.localPath, "agent", "tools"))
        .filter((f) => /\.(ts|js)$/.test(f))
        .map((f) => f.replace(/\.(ts|js)$/, ""))
        .sort();
    } catch { return []; }
  };
  // Schedules read live too, with their cron pulled from the source — eve info
  // reports only names.
  const liveSchedules = () => {
    try {
      return readdirSync(join(project.localPath, "agent", "schedules"))
        .filter((f) => /\.(ts|js)$/.test(f))
        .map((f) => {
          const name = f.replace(/\.(ts|js)$/, "");
          let cron = null;
          try {
            cron = readFileSync(join(project.localPath, "agent", "schedules", f), "utf8")
              .match(/cron:\s*['"\`]([^'"\`]+)['"\`]/)?.[1] ?? null;
          } catch {}
          return { name, cron };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch { return []; }
  };

  const hit = cache.get(project.name);
  if (!fresh && hit && Date.now() - hit.at < TTL * 6) {
    return Response.json({ ...hit.data, tools: liveTools(), schedules: liveSchedules() });
  }

  try {
    const { stdout } = await exec("npm", ["exec", "--", "eve", "info", "--json"], {
      cwd: project.localPath, timeout: 120_000, maxBuffer: 16 << 20,
    });
    const info = JSON.parse(stdout.slice(stdout.indexOf("{")));

    // Group channel routes: the eve HTTP channel is many routes but one surface.
    const byChannel = new Map();
    for (const c of info.channels ?? []) {
      const key = `${c.name}:${c.kind}`;
      if (!byChannel.has(key)) byChannel.set(key, { name: c.name, kind: c.kind, routes: 0 });
      byChannel.get(key).routes += 1;
    }

    const data = {
      name: info.agent?.name ?? info.name ?? project.name,
      model: info.model ?? info.agent?.model?.id ?? null,
      instructions: info.instructions ?? null,
      tools: liveTools(),
      skills: info.skills ?? [],
      subagents: info.subagents ?? [],
      schedules: liveSchedules(),
      channels: [...byChannel.values()],
      diagnostics: info.diagnostics ?? null,
    };
    cache.set(project.name, { at: Date.now(), data });
    return Response.json(data);
  } catch (e) {
    return Response.json({ error: `eve info failed: ${String(e.message ?? e).slice(0, 250)}` }, { status: 502 });
  }
}
