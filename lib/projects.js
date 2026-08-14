// Project discovery: Vercel projects + locally running eve dev servers, merged.
//
// Local detection works by enumerating listening TCP ports and probing each for
// GET /eve/v1/info. That endpoint identifies the agent by name and app root, which
// is far more reliable than matching process command lines.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const exec = promisify(execFile);

const CACHE_MS = 15_000;
let vercelCache = { at: 0, data: [] };

export const TEAM = process.env.EVE_TEAM || null;

// `eve dev` serves from a snapshot of the source, so appRoot points at
// <project>/.eve/dev-runtime/snapshots/<deploymentId>/source. Unwrap it.
export function projectRootFromAppRoot(appRoot) {
  if (!appRoot) return null;
  const m = appRoot.match(/^(.*?)\/\.eve\/dev-runtime\/snapshots\/[^/]+\/source\/?$/);
  return m ? m[1] : appRoot;
}

async function listeningPorts() {
  try {
    const { stdout } = await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { maxBuffer: 8 << 20 });
    const ports = new Set();
    for (const line of stdout.split("\n").slice(1)) {
      const addr = line.split(/\s+/)[8];
      if (!addr) continue;
      const p = Number(addr.split(":").pop());
      // Skip ephemeral/system ranges; dev servers live well below this.
      if (Number.isFinite(p) && p > 1024 && p < 40000) ports.add(p);
    }
    return [...ports].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

async function probe(port) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 600);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/eve/v1/info`, { signal: ctrl.signal });
    if (!r.ok) return null;
    const info = await r.json();
    if (!info?.agent?.name) return null;

    const root = projectRootFromAppRoot(info.agent.appRoot);
    let link = null;
    if (root && existsSync(join(root, ".vercel", "project.json"))) {
      try { link = JSON.parse(readFileSync(join(root, ".vercel", "project.json"), "utf8")); } catch {}
    }
    return {
      port,
      url: `http://127.0.0.1:${port}`,
      agentName: info.agent.name,
      model: info.agent?.model?.id ?? null,
      projectRoot: root,
      vercelProjectId: link?.projectId ?? null,
      vercelProjectName: link?.projectName ?? null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function localServers() {
  const ports = await listeningPorts();
  const results = await Promise.all(ports.map(probe));
  return results.filter(Boolean);
}

export async function vercelProjects() {
  if (Date.now() - vercelCache.at < CACHE_MS) return vercelCache.data;
  try {
    const args = ["projects", "ls", "--json"];
    if (TEAM) args.push("--scope", TEAM);
    const { stdout } = await exec("vercel", args, { maxBuffer: 16 << 20 });
    const i = stdout.indexOf("{");
    const parsed = i === -1 ? { projects: [] } : JSON.parse(stdout.slice(i));
    const data = (parsed.projects ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      productionUrl: p.latestProductionUrl && p.latestProductionUrl !== "--" ? p.latestProductionUrl : null,
      updatedAt: p.updatedAt ?? null,
    }));
    vercelCache = { at: Date.now(), data };
    return data;
  } catch {
    return vercelCache.data;
  }
}

// Merge the two views. A project is "live" when a local eve dev server is linked
// to it; servers with no Vercel link still show up as local-only entries.
export async function listProjects() {
  const [remote, local] = await Promise.all([vercelProjects(), localServers()]);

  const byId = new Map();
  const byName = new Map();
  for (const s of local) {
    if (s.vercelProjectId) byId.set(s.vercelProjectId, s);
    byName.set(s.vercelProjectName ?? s.agentName, s);
  }

  const merged = remote.map((p) => {
    const s = byId.get(p.id) ?? byName.get(p.name) ?? null;
    return {
      ...p,
      source: "vercel",
      live: Boolean(s),
      localPath: s?.projectRoot ?? null,
      localUrl: s?.url ?? null,
      localPort: s?.port ?? null,
      agentName: s?.agentName ?? null,
      model: s?.model ?? null,
    };
  });

  const claimed = new Set(merged.filter((p) => p.live).map((p) => p.localPort));
  for (const s of local) {
    if (claimed.has(s.port)) continue;
    merged.unshift({
      id: null,
      name: s.vercelProjectName ?? s.agentName,
      productionUrl: null,
      updatedAt: Date.now(),
      source: "local",
      live: true,
      localPath: s.projectRoot,
      localUrl: s.url,
      localPort: s.port,
      agentName: s.agentName,
      model: s.model,
    });
  }

  // Live projects first, then by most recently updated.
  merged.sort((a, b) => Number(b.live) - Number(a.live) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return merged;
}

// The workflow CLI resolves credentials from a real .vercel/project.json and
// 401s without one — the WORKFLOW_VERCEL_PROJECT/TEAM env vars are not enough.
// For projects with no local checkout, cache a link directory per project.
// `vercel link` against an existing project only reads; it creates nothing remote.
const LINK_CACHE = join(process.env.HOME ?? tmpdir(), ".cache", "eve-cockpit", "links");

export async function ensureLinkDir(project) {
  if (project.localPath) return project.localPath;
  const dir = join(LINK_CACHE, project.name);
  if (existsSync(join(dir, ".vercel", "project.json"))) return dir;

  mkdirSync(dir, { recursive: true });
  const args = ["link", "--yes", "--project", project.name];
  if (TEAM) args.push("--scope", TEAM);
  await exec("vercel", args, { cwd: dir, maxBuffer: 8 << 20 });
  return dir;
}

export async function resolveProject(name) {
  const all = await listProjects();
  if (!name) return all.find((p) => p.live) ?? all[0] ?? null;
  return all.find((p) => p.name === name) ?? null;
}
