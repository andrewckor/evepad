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
import { knownPath, remember, allKnown } from "./registry.js";

const exec = promisify(execFile);

const CACHE_MS = 15_000;
let vercelCache = { at: 0, key: null, data: [] };

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

// Every data request resolves a project, so this runs on the 2s poll path. Without
// a cache that means an lsof spawn plus a probe of every listening port, twice a
// second. Dev servers do not appear and vanish that fast.
let localCache = { at: 0, data: [] };
const LOCAL_TTL = 4_000;

export async function localServers() {
  if (Date.now() - localCache.at < LOCAL_TTL) return localCache.data;
  const ports = await listeningPorts();
  const results = await Promise.all(ports.map(probe));
  const servers = results.filter(Boolean);
  // Remember every observed checkout so the play button (and local reads) work
  // after the server stops.
  for (const s of servers) remember(s.vercelProjectName ?? s.agentName, s.projectRoot);
  localCache = { at: Date.now(), data: servers };
  return localCache.data;
}

// REST API, not `vercel projects ls` — the CLI costs ~0.9s per spawn and its
// JSON omits `framework`, which is how we tell eve agents from everything else.
// Reuses the CLI's stored login so there is nothing extra to configure.
function cliToken() {
  if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN;
  try {
    const base = process.platform === "darwin"
      ? join(process.env.HOME, "Library", "Application Support", "com.vercel.cli")
      : join(process.env.HOME, ".local", "share", "com.vercel.cli");
    return JSON.parse(readFileSync(join(base, "auth.json"), "utf8")).token ?? null;
  } catch {
    return null;
  }
}

function currentTeam() {
  if (TEAM) return TEAM;
  try {
    const base = process.platform === "darwin"
      ? join(process.env.HOME, "Library", "Application Support", "com.vercel.cli")
      : join(process.env.HOME, ".local", "share", "com.vercel.cli");
    return JSON.parse(readFileSync(join(base, "config.json"), "utf8")).currentTeam ?? null;
  } catch {
    return null;
  }
}

export async function vercelProjects() {
  const token = cliToken();
  const key = token ? token.slice(0, 12) + ":" + (currentTeam() ?? "") : null;
  // The cache is identity-keyed: a login/logout/team-switch invalidates it
  // instantly instead of serving the previous identity's projects.
  if (vercelCache.key === key && Date.now() - vercelCache.at < CACHE_MS) return vercelCache.data;
  try {
    if (!token) throw new Error("no Vercel token (run `vercel login` or set VERCEL_TOKEN)");
    const qs = new URLSearchParams({ limit: "100" });
    const team = currentTeam();
    if (team) qs.set(team.startsWith("team_") ? "teamId" : "slug", team);
    const r = await fetch(`https://api.vercel.com/v10/projects?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`projects API ${r.status}`);
    const body = await r.json();
    const data = (body.projects ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      accountId: p.accountId ?? null,
      framework: p.framework ?? null,
      productionUrl: p.targets?.production?.alias?.[0] ? `https://${p.targets.production.alias[0]}` : null,
      framework: p.framework ?? null,
      // Vercel stores the deploy-detected favicon as an avatar hash; the www
      // avatar endpoint serves it publicly.
      avatarUrl: p.avatar ? `https://vercel.com/api/www/avatar/${p.avatar}?s=64` : null,
      // The dashboard's own icon service: detected favicon, else the OFFICIAL
      // framework logo (eve mark included). Public, nothing vendored locally.
      iconUrl: (() => {
        const dpl = p.targets?.production?.id ?? p.latestDeployments?.[0]?.id;
        if (!dpl) return null;
        const qs = new URLSearchParams({
          project: p.name,
          projectFramework: p.framework ?? "",
          readyState: "READY",
          teamId: p.accountId ?? "",
          dpl,
        });
        return `https://vercel.com/api/v0/deployments/${dpl}/favicon?${qs}`;
      })(),
      updatedAt: p.updatedAt ?? null,
    }));
    vercelCache = { at: Date.now(), key, data };
    return data;
  } catch {
    // Same identity: stale beats nothing. Different identity: serve NOTHING
    // rather than another account's list.
    return vercelCache.key === key ? vercelCache.data : [];
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

  // Only eve agents belong in the cockpit. Local servers are eve by definition
  // (they answered /eve/v1/info); remote projects qualify by framework.
  const merged = remote.map((p) => {
    const s = byId.get(p.id) ?? byName.get(p.name) ?? null;
    return {
      ...p,
      source: "vercel",
      live: Boolean(s),
      // Fall back to the registry so a stopped project keeps its path — that is
      // what enables the play button and reading its local .eve store.
      localPath: s?.projectRoot ?? knownPath(p.name),
      localUrl: s?.url ?? null,
      localPort: s?.port ?? null,
      agentName: s?.agentName ?? null,
      model: s?.model ?? null,
      // Framework proof beyond the Vercel tag: a live eve dev server, or the
      // registry (which only ever records checkouts that answered eve dev).
      framework: p.framework ?? (s || knownPath(p.name) ? "eve" : null),
    };
  });

  const claimed = new Set(merged.filter((p) => p.live).map((p) => p.localPort));
  for (const s of local) {
    if (claimed.has(s.port)) continue;
    merged.unshift({
      id: null,
      name: s.vercelProjectName ?? s.agentName,
      productionUrl: null,
      framework: "eve", // a live eve dev server is its own proof
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

  // Stopped-but-remembered checkouts stay on the board. Ownership scope:
  // an entry linked to a Vercel org is visible only while the CURRENT login
  // can see that org (logout/user-switch hides it, logging back restores it,
  // and the check is live so there is no stale state to clean up). Unlinked
  // checkouts are machine-local and always visible.
  const visibleOrgs = new Set(remote.map((p) => p.accountId).filter(Boolean));
  const present = new Set(merged.map((p) => p.name));
  for (const e of allKnown()) {
    if (present.has(e.name)) continue;
    if (e.orgId && !visibleOrgs.has(e.orgId)) continue;
    merged.push({
      id: e.projectId,
      name: e.name,
      productionUrl: null,
      framework: "eve",
      updatedAt: e.lastSeenAt ? Date.parse(e.lastSeenAt) : null,
      source: "registry",
      live: false,
      localPath: e.path,
      localUrl: null,
      localPort: null,
      agentName: null,
      model: null,
    });
  }

  // Live projects first, then by most recently updated.
  // Filtered after the merge so a live eve dev server counts as proof.
  const eveOnly = merged.filter((p) => p.framework === "eve");
  eveOnly.sort((a, b) =>
    Number(b.live) - Number(a.live) ||
    (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return eveOnly;
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
