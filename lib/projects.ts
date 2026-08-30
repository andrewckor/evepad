// Project discovery: Vercel projects + locally running eve dev servers, merged.
//
// Local detection works by enumerating listening TCP ports and probing each for
// GET /eve/v1/info. That endpoint identifies the agent by name and app root, which
// is far more reliable than matching process command lines.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cacheDir } from "./cache-dir";
import { remember, allKnown } from "./registry";
import { indexLinkedProjects, localLinkVisible } from "./project-visibility";
import { collectVercelProjectPages } from "./vercel-project-pages";
import type { LocalServer, Project } from "./types";

const exec = promisify(execFile);

const CACHE_MS = 15_000;
let vercelCache: { at: number; key: string | null; data: Project[] } = {
  at: 0,
  key: null,
  data: [],
};

export const TEAM = process.env.EVE_TEAM || null;

// `eve dev` serves from a snapshot of the source, so appRoot points at
// <project>/.eve/dev-runtime/snapshots/<deploymentId>/source. Unwrap it.
export function projectRootFromAppRoot(appRoot: string | null | undefined): string | null {
  if (!appRoot) return null;
  const m = appRoot.match(/^(.*?)\/\.eve\/dev-runtime\/snapshots\/[^/]+\/source\/?$/);
  return m ? (m[1] ?? null) : appRoot;
}

async function listeningPorts(): Promise<number[]> {
  try {
    const { stdout } = await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { maxBuffer: 8 << 20 });
    const ports = new Set<number>();
    // Our own port is listening too, and probing it just logs a 404 per scan.
    const self = Number(process.env.PORT);
    for (const line of stdout.split("\n").slice(1)) {
      const addr = line.split(/\s+/)[8];
      if (!addr) continue;
      const p = Number(addr.split(":").pop());
      // Skip ephemeral/system ranges; dev servers live well below this.
      if (Number.isFinite(p) && p > 1024 && p < 40000 && p !== self) ports.add(p);
    }
    return [...ports].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

async function probe(port: number): Promise<LocalServer | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 600);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/eve/v1/info`, { signal: ctrl.signal });
    if (!r.ok) return null;
    const info = await r.json();
    if (!info?.agent?.name) return null;

    const root = projectRootFromAppRoot(info.agent.appRoot);
    let link: { projectId?: string; orgId?: string; projectName?: string } | null = null;
    if (root && existsSync(join(root, ".vercel", "project.json"))) {
      try {
        link = JSON.parse(readFileSync(join(root, ".vercel", "project.json"), "utf8"));
      } catch {}
    }
    return {
      port,
      url: `http://127.0.0.1:${port}`,
      agentName: info.agent.name,
      model: info.agent?.model?.id ?? null,
      projectRoot: root,
      vercelProjectId: link?.projectId ?? null,
      vercelOrgId: link?.orgId ?? null,
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
let localCache: { at: number; data: LocalServer[] } = { at: 0, data: [] };
const LOCAL_TTL = 4_000;

// Start/stop just changed reality — the next listing must look, not trust
// a snapshot taken before the action. The epoch also disarms scans already
// in flight: one started before the action would otherwise finish after the
// invalidation and write pre-action state back into the cache.
let localEpoch = 0;
export function invalidateLocalServers(): void {
  localEpoch++;
  localCache.at = 0;
}

// Agent creation just made a project the ≤15s snapshot can't contain, which
// left the fresh agent's Build page on "No local checkout." until the TTL.
export function invalidateVercelProjects(): void {
  vercelCache.at = 0;
}

export async function localServers() {
  if (Date.now() - localCache.at < LOCAL_TTL) return localCache.data;
  const epoch = localEpoch;
  const ports = await listeningPorts();
  const results = await Promise.all(ports.map(probe));
  const servers = results.filter((s): s is LocalServer => s !== null);
  // Remember every observed checkout so the play button (and local reads) work
  // after the server stops.
  for (const s of servers)
    if (s.projectRoot) remember(s.vercelProjectName ?? s.agentName, s.projectRoot);
  if (epoch === localEpoch) localCache = { at: Date.now(), data: servers };
  return servers;
}

// REST API, not `vercel projects ls` — the CLI costs ~0.9s per spawn and its
// JSON omits `framework`, which is how we tell eve agents from everything else.
// Reuses the CLI's stored login so there is nothing extra to configure.
export function cliToken(): string | null {
  if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN;
  try {
    const home = process.env.HOME ?? "";
    const base =
      process.platform === "darwin"
        ? join(home, "Library", "Application Support", "com.vercel.cli")
        : join(home, ".local", "share", "com.vercel.cli");
    return JSON.parse(readFileSync(join(base, "auth.json"), "utf8")).token ?? null;
  } catch {
    return null;
  }
}

export function currentTeam(): string | null {
  if (TEAM) return TEAM;
  try {
    const home = process.env.HOME ?? "";
    const base =
      process.platform === "darwin"
        ? join(home, "Library", "Application Support", "com.vercel.cli")
        : join(home, ".local", "share", "com.vercel.cli");
    return JSON.parse(readFileSync(join(base, "config.json"), "utf8")).currentTeam ?? null;
  } catch {
    return null;
  }
}

// Short opaque tag for the current Vercel identity (token+team). Used to
// namespace client-side storage so two logins on one browser profile don't
// inherit each other's preferences or session pointers. "anon" when logged out.
export function identityTag(): string {
  const token = cliToken();
  if (!token) return "anon";
  let h = 0;
  const src = token + ":" + (currentTeam() ?? "");
  for (let i = 0; i < src.length; i++) h = ((h << 5) - h + src.charCodeAt(i)) | 0;
  return "u" + (h >>> 0).toString(36);
}

type VercelApiProject = {
  id: string;
  name: string;
  accountId?: string;
  framework?: string | null;
  avatar?: string;
  updatedAt?: number;
  targets?: { production?: { id?: string; alias?: string[] } };
  latestDeployments?: Array<{ id: string }>;
};

export async function vercelProjects(): Promise<Project[]> {
  const token = cliToken();
  const key = token ? token.slice(0, 12) + ":" + (currentTeam() ?? "") : null;
  // The cache is identity-keyed: a login/logout/team-switch invalidates it
  // instantly instead of serving the previous identity's projects.
  if (vercelCache.key === key && Date.now() - vercelCache.at < CACHE_MS) return vercelCache.data;
  try {
    if (!token) throw new Error("no Vercel token (run `vercel login` or set VERCEL_TOKEN)");
    const team = currentTeam();
    const apiProjects = await collectVercelProjectPages(async (until) => {
      const qs = new URLSearchParams({ limit: "100" });
      if (team) qs.set(team.startsWith("team_") ? "teamId" : "slug", team);
      if (until) qs.set("until", until);
      const r = await fetch(`https://api.vercel.com/v10/projects?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`projects API ${r.status}`);
      return (await r.json()) as {
        projects?: VercelApiProject[];
        pagination?: { next?: string | number | null };
      };
    });
    const data: Project[] = apiProjects.map((p) => ({
      id: p.id,
      name: p.name,
      accountId: p.accountId ?? null,
      framework: p.framework ?? null,
      productionUrl: p.targets?.production?.alias?.[0]
        ? `https://${p.targets.production.alias[0]}`
        : null,
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
      source: "vercel" as const,
      live: false,
      localPath: null,
      localUrl: null,
      localPort: null,
      agentName: null,
      model: null,
    }));
    vercelCache = { at: Date.now(), key, data };
    lastProjectsError = null;
    return data;
  } catch (e) {
    // Keep WHY. Swallowing it turned an expired token into an empty project
    // list, which every caller then reported as "no project" — a message that
    // sends you looking for a missing project instead of at your credentials.
    lastProjectsError = e instanceof Error ? e.message : String(e);
    // Same identity: stale beats nothing. Different identity: serve NOTHING
    // rather than another account's list.
    return vercelCache.key === key ? vercelCache.data : [];
  }
}

// Why the last project listing failed, or null if it didn't. Read by listRuns
// so a resolution failure can be classified as auth rather than "no project".
let lastProjectsError: string | null = null;
export function projectsError(): string | null {
  return lastProjectsError;
}

// Installed eve version of a checkout (node_modules first — the truth — then
// the package.json range). Cached briefly; this sits on the 5s poll path.
const eveVerCache = new Map<string, { at: number; v: string | null }>();
export function eveVersionAt(root: string | null | undefined): string | null {
  if (!root) return null;
  const hit = eveVerCache.get(root);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  let v: string | null = null;
  try {
    v =
      JSON.parse(readFileSync(join(root, "node_modules", "eve", "package.json"), "utf8")).version ??
      null;
  } catch {}
  if (!v) {
    try {
      const deps = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      v =
        (deps.dependencies?.eve ?? deps.devDependencies?.eve ?? "").replace(/^[^0-9]*/, "") || null;
    } catch {}
  }
  eveVerCache.set(root, { at: Date.now(), v });
  return v;
}

// Merge the two views. A project is "live" when a local eve dev server is linked
// to it; servers with no Vercel link still show up as local-only entries.
export async function listProjects(): Promise<Project[]> {
  const [remote, local] = await Promise.all([vercelProjects(), localServers()]);

  const visibleProjectIds = new Set(
    remote.map((p) => p.id).filter((id): id is string => Boolean(id)),
  );
  const visibleOrgs = new Set(
    remote.map((p) => p.accountId).filter((id): id is string => Boolean(id)),
  );
  const visibleLocal = local.filter((server) =>
    localLinkVisible(
      { projectId: server.vercelProjectId, orgId: server.vercelOrgId },
      visibleProjectIds,
      visibleOrgs,
    ),
  );
  const visibleKnown = allKnown().filter((entry) =>
    localLinkVisible(entry, visibleProjectIds, visibleOrgs),
  );

  const byId = indexLinkedProjects(visibleLocal, (server) => server.vercelProjectId);
  const knownById = indexLinkedProjects(visibleKnown, (entry) => entry.projectId);

  // Only eve agents belong in evepad. Local servers are eve by definition
  // (they answered /eve/v1/info); remote projects qualify by framework.
  const merged: Project[] = remote.map((p) => {
    const s = p.id ? (byId.get(p.id) ?? null) : null;
    const remembered = p.id ? (knownById.get(p.id) ?? null) : null;
    return {
      ...p,
      source: "vercel",
      live: Boolean(s),
      // Fall back to the registry so a stopped project keeps its path — that is
      // what enables the play button and reading its local .eve store.
      localPath: s?.projectRoot ?? remembered?.path ?? null,
      localUrl: s?.url ?? null,
      localPort: s?.port ?? null,
      agentName: s?.agentName ?? null,
      model: s?.model ?? null,
      // Framework proof beyond the Vercel tag: a live eve dev server, or the
      // registry (which only ever records checkouts that answered eve dev).
      framework: p.framework ?? (s || remembered ? "eve" : null),
    };
  });

  const claimed = new Set(merged.filter((p) => p.live).map((p) => p.localPort));
  for (const s of visibleLocal) {
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

  // Stopped-but-remembered checkouts stay on the board. A linked entry is
  // visible only when BOTH its project and org belong to the current scope;
  // logout/account-switch hides it immediately. Unlinked checkouts are local
  // to the machine and remain visible.
  const present = new Set(merged.map((p) => p.name));
  for (const e of visibleKnown) {
    if (present.has(e.name)) continue;
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
  eveOnly.sort(
    (a, b) => Number(b.live) - Number(a.live) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  );
  return eveOnly;
}

// The workflow CLI resolves credentials from a real .vercel/project.json and
// 401s without one — the WORKFLOW_VERCEL_PROJECT/TEAM env vars are not enough.
// For projects with no local checkout, cache a link directory per project.
// `vercel link` against an existing project only reads; it creates nothing remote.
const LINK_CACHE = join(cacheDir(), "links");

export async function ensureLinkDir(project: Project): Promise<string> {
  if (project.localPath) return project.localPath;
  const dir = join(LINK_CACHE, project.name);
  if (existsSync(join(dir, ".vercel", "project.json"))) return dir;

  mkdirSync(dir, { recursive: true });
  const args = ["link", "--yes", "--project", project.name];
  if (TEAM) args.push("--scope", TEAM);
  await exec("vercel", args, { cwd: dir, maxBuffer: 8 << 20 });
  return dir;
}

export async function resolveProject(name: string | null | undefined): Promise<Project | null> {
  const all = await listProjects();
  if (!name) return all.find((p) => p.live) ?? all[0] ?? null;
  return all.find((p) => p.name === name) ?? null;
}
