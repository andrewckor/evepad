// OpenCode server management: ONE SERVER PER PROJECT DIRECTORY.
//
// Why per-project: the AI Gateway authenticates via VERCEL_OIDC_TOKEN in the
// server's env, and tokens are per project. A single shared server made every
// ocClient(dirA)/ocClient(dirB) pair kill-and-reboot each other's server
// (bootToken mismatch), obliterating in-flight runs and pending permission
// asks — the root cause of every "working but shows nothing" wedge.
//
// Guardrails come from OpenCode's own permission system: edits allowed inside
// the project, bash asks (evepad UI renders approval toasts),
// external_directory denied.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { createOpencodeServer, createOpencodeClient } from "@opencode-ai/sdk";
import { vercelCommand } from "./vercel-cli";
import type { Project } from "./types";

export type OcClient = ReturnType<typeof createOpencodeClient>;
type OcServer = Awaited<ReturnType<typeof createOpencodeServer>>;
type ReadyEntry = { server: OcServer; client: OcClient; bootToken: string; lastSeen?: number };
type ServerEntry = Partial<ReadyEntry> & { booting?: Promise<ReadyEntry> };

// An event off the server's bus. The SDK types each variant precisely; the
// hub fans them out without caring which one it holds.
export type OcEvent = { type: string; properties?: Record<string, any> };

export type EventHub = {
  v: number;
  subs: Set<(ev: OcEvent) => void>;
  pending: Map<string, OcEvent>;
  state: string;
  events: number;
  types: Record<string, number>;
  resubscribe?: () => Promise<unknown>;
  onLive?: ((value?: unknown) => void) | null;
  kicked?: boolean;
  abort?: AbortController;
};

type OcGlobal = {
  servers: Map<string, ServerEntry>;
  hubs: Map<string, EventHub>;
  pulls: Map<string, Promise<string | null>>;
  install?: Promise<void> | null;
  cleanupInstalled?: boolean;
};

const exec = promisify(execFile);
const DEFAULT_PROVIDER = "vercel";
const DEFAULT_MODEL = "zai/glm-5.2";

const g = ((globalThis as { __evepadOpencode?: Partial<OcGlobal> }).__evepadOpencode ??=
  {}) as OcGlobal;
g.servers ??= new Map();
g.hubs ??= new Map();
g.pulls ??= new Map();

function readOidc(dir: string): string | null {
  try {
    return (
      readFileSync(join(dir, ".env.local"), "utf8").match(
        /^VERCEL_OIDC_TOKEN="?([^"\n]+)"?/m,
      )?.[1] ?? null
    );
  } catch {
    return null;
  }
}
const isExpired = (t: string): boolean => {
  try {
    return (
      JSON.parse(Buffer.from(t.split(".")[1] ?? "", "base64url").toString()).exp * 1000 <
      Date.now() + 60_000
    );
  } catch {
    return true;
  }
};
export async function freshOidc(dir: string): Promise<string | null> {
  let t = readOidc(dir);
  if (!t || isExpired(t)) {
    // One pull per directory at a time: every /api/oc/* call lands here, and
    // an expired token used to fan out into N concurrent `vercel env pull`s.
    let pull = g.pulls.get(dir);
    if (!pull) {
      pull = (async () => {
        try {
          const [vc, ...pre] = vercelCommand() as [string, ...string[]];
          await exec(vc, [...pre, "env", "pull", ".env.local", "--yes"], {
            cwd: dir,
            timeout: 60_000,
          });
        } catch {}
        return readOidc(dir);
      })().finally(() => g.pulls.delete(dir));
      g.pulls.set(dir, pull);
    }
    t = await pull;
  }
  return t && !isExpired(t) ? t : null;
}

// Keep in lockstep with @opencode-ai/sdk in package.json — the bundled client
// talks to the server this installs.
const OPENCODE_VERSION = "1.18.18";

// One prefix PER VERSION: an evepad release that bumps OPENCODE_VERSION gets a
// fresh install, never an in-place update over the old one — npm run from the
// standalone server drops the .bin link on in-place updates.
const managedRoot = () => join(homedir(), ".evepad", "opencode");
const managedPrefix = () => join(managedRoot(), OPENCODE_VERSION);

const onPath = async (cmd: string): Promise<boolean> => {
  try {
    await exec("which", [cmd]);
    return true;
  } catch {
    return false;
  }
};

// The binary lands in one of two layouts: package/bin (direct tarball
// extract, the fast path) or node_modules/.bin (the npm fallback).
const managedBinDirs = () => [
  join(managedPrefix(), "package", "bin"),
  join(managedPrefix(), "node_modules", ".bin"),
];
const managedBin = () => managedBinDirs().find((d) => existsSync(join(d, "opencode"))) ?? null;

// The npm registry tarball for this machine's platform binary. The registry
// is what npm itself would hit — same bytes, none of npm's overhead (node
// startup, metadata round-trips, and a second full copy in the npm cache).
const platformTarball = () => {
  const plat = process.platform === "win32" ? "windows" : process.platform;
  const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } };
  const musl = process.platform === "linux" && !report?.header?.glibcVersionRuntime;
  const pkg = `opencode-${plat}-${process.arch}${musl ? "-musl" : ""}`;
  return `https://registry.npmjs.org/${pkg}/-/${pkg}-${OPENCODE_VERSION}.tgz`;
};

// Direct fetch piped through tar: ~1.3s vs ~5.5s for the npm route.
async function downloadDirect(): Promise<void> {
  const dest = managedPrefix();
  mkdirSync(dest, { recursive: true });
  const res = await fetch(platformTarball(), { signal: AbortSignal.timeout(240_000) });
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
  const tar = spawn("tar", ["-xz", "-C", dest], { stdio: ["pipe", "ignore", "ignore"] });
  Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]).pipe(tar.stdin);
  await new Promise<void>((resolve, reject) => {
    tar.on("error", reject);
    tar.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
  });
}

async function installViaNpm(): Promise<void> {
  await exec(
    "npm",
    [
      "install",
      "--prefix",
      managedPrefix(),
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      `opencode-ai@${OPENCODE_VERSION}`,
    ],
    { timeout: 300_000 },
  );
}

// The published package doesn't bundle opencode (its platform binary is
// 143MB, ~90% of the old install). Resolution order: the managed copy in
// ~/.evepad/opencode/<version> when it exists; else a ~1.3s direct download
// of the pinned version. Every user runs the pinned copy — a user-owned
// opencode on PATH is only the last-ditch fallback when the download itself
// fails (offline first run). The launcher (bin/evepad.mjs) runs the same
// decision before the server spawns; this is the safety net for
// `npm run dev` and launcher failures, reported via installing:true.
async function ensureOpencodeBinary(): Promise<void> {
  const have = managedBin();
  if (have) {
    if (!process.env.PATH?.includes(have)) process.env.PATH = `${have}:${process.env.PATH ?? ""}`;
    return;
  }
  g.install ??= downloadDirect().catch(installViaNpm);
  try {
    await g.install;
    // Older versions are ~140MB each of dead weight — sweep the siblings
    // once the new install is in.
    try {
      for (const d of readdirSync(managedRoot()))
        if (d !== OPENCODE_VERSION)
          rmSync(join(managedRoot(), d), { recursive: true, force: true });
    } catch {}
  } catch {
    // Both installers failed (offline?) — fall through to the checks below,
    // which end in the actionable error, not npm's.
  } finally {
    g.install = null;
  }
  const bin = managedBin();
  if (bin) {
    if (!process.env.PATH?.includes(bin)) process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
    return;
  }
  // Install failed (offline?) — a PATH copy is version drift, but version
  // drift beats a dead Build tab.
  if (!(await onPath("opencode")))
    throw new Error(
      "Could not set up the editor — install opencode yourself: `npm i -g opencode-ai`, then reload.",
    );
}

export const opencodeInstalling = (): boolean => Boolean(g.install);

// Awaited by instrumentation.ts at server boot: "ready" is not printed until
// the editor is installed, so a cold `npx evepad` is honest about its one
// slow step and everything after it is instant. Errors don't kill the boot —
// Build retries and falls back on its own (see ensureOpencodeBinary).
export async function warmOpencodeInstall(): Promise<void> {
  try {
    await ensureOpencodeBinary();
  } catch {}
}

async function bootServer(_dir: string, oidc: string): Promise<ReadyEntry> {
  await ensureOpencodeBinary();
  // The child inherits process.env at spawn — set the project's token just
  // for this boot. (Sequential boots are fine; the mutex below serializes.)
  process.env.VERCEL_OIDC_TOKEN = oidc;
  // The SDK's default port (4096) collides with any prior/orphaned server and
  // opencode dies with an opaque ServeError — always pick a free port.
  const { createServer } = await import("node:net");
  const port = await new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
  const server = await createOpencodeServer({
    hostname: "127.0.0.1",
    port,
    timeout: 15_000,
    config: {
      // Server-side default model — an attached TUI inherits this too.
      model: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
      // Master prompt: what an eve agent is, its file anatomy, working rules.
      instructions: [join(process.cwd(), "lib", "eve-agent-prompt.md")],
      permission: { edit: "allow", bash: "ask", webfetch: "allow", external_directory: "deny" },
      // Vercel AI Gateway as a real provider: opencode loads @ai-sdk/gateway,
      // which auto-authenticates from VERCEL_OIDC_TOKEN in the server env.
      provider: {
        vercel: {
          npm: "@ai-sdk/gateway",
          name: "Vercel AI Gateway",
          models: {
            "zai/glm-5.2": { name: "GLM 5.2" },
            "zai/glm-5.2-fast": { name: "GLM 5.2 Fast" },
          },
        },
      },
    },
  });
  return { server, client: createOpencodeClient({ baseUrl: server.url }), bootToken: oidc };
}

async function ensureServer(dir: string, oidc: string): Promise<ReadyEntry> {
  const entry = g.servers.get(dir);
  if (entry?.booting) {
    await entry.booting;
    return g.servers.get(dir) as ReadyEntry;
  }
  if (entry?.server && entry.bootToken === oidc) {
    // Handles survive hot reloads on globalThis but the process behind them
    // may be gone — verify liveness before trusting the cached server. A
    // probe every call is a wasted round-trip on hot paths, so one sighting
    // vouches for the next 2s.
    if (entry.lastSeen && Date.now() - entry.lastSeen < 2_000) return entry as ReadyEntry;
    try {
      const ok = await fetch(`${entry.server.url}/app`, { signal: AbortSignal.timeout(1500) });
      if (ok.ok) {
        entry.lastSeen = Date.now();
        return entry as ReadyEntry;
      }
    } catch {}
  }
  if (entry?.server) {
    try {
      entry.server.close();
    } catch {}
  }
  g.hubs.get(dir)?.pending.clear();

  // Boot mutex: concurrent callers (page load fires state+events+messages at
  // once) must not each spawn a server — the extras become orphans holding
  // the shared sqlite lock.
  const booting = bootServer(dir, oidc);
  g.servers.set(dir, { booting });
  try {
    const fresh = await booting;
    g.servers.set(dir, fresh);
  } catch (e) {
    g.servers.delete(dir);
    throw e;
  }

  // Never orphan opencode servers: close them all when evepad dies.
  if (!g.cleanupInstalled) {
    g.cleanupInstalled = true;
    const shutdown = () => {
      for (const en of g.servers.values()) {
        try {
          en.server?.close();
        } catch {}
      }
    };
    process.on("exit", shutdown);
    for (const sig of ["SIGINT", "SIGTERM"]) {
      process.on(sig, () => {
        shutdown();
        process.exit(0);
      });
    }
  }
  return g.servers.get(dir) as ReadyEntry;
}

// The raw SDK client for a project checkout — the /api/oc/* routes are thin
// passthroughs over this. Boots/heals that project's server on demand.
export async function ocClient(dir: string): Promise<{ client: OcClient; dir: string }> {
  const oidc = await freshOidc(dir);
  if (!oidc)
    throw new Error("No AI Gateway credentials — press play once or run `vercel env pull`.");
  const entry = await ensureServer(dir, oidc);
  return { client: entry.client, dir };
}

// This project's server URL — a TUI can attach here and share sessions.
export async function opencodeServerUrl(dir: string): Promise<string> {
  await ocClient(dir);
  return (g.servers.get(dir) as ReadyEntry).server.url;
}

// Every model this project's server can route to, for the model picker.
export type ModelInfo = {
  providerID: string;
  modelID: string;
  name: string;
  provider: string;
  free: boolean;
  default: boolean;
};

export async function listModels(
  project: Project,
  pre?: { client: OcClient },
): Promise<ModelInfo[]> {
  if (!project.localPath) throw new Error("no local checkout for this project");
  const { client } = pre ?? (await ocClient(project.localPath));
  const res = await client.config.providers({ throwOnError: true });
  const models: ModelInfo[] = [];
  for (const prov of res.data.providers ?? []) {
    for (const [modelID, m] of Object.entries(prov.models ?? {})) {
      // Coding chat needs tool calls — skip embeddings/media/rerank models.
      if (m.capabilities && !m.capabilities.toolcall) continue;
      models.push({
        providerID: prov.id,
        modelID,
        name: m.name ?? modelID,
        provider: prov.name ?? prov.id,
        free: m.cost ? m.cost.input === 0 && m.cost.output === 0 : false,
        default: prov.id === DEFAULT_PROVIDER && modelID === DEFAULT_MODEL,
      });
    }
  }
  // Gateway (free via project creds) first, then everything else by name.
  models.sort(
    (a, b) =>
      (a.providerID === DEFAULT_PROVIDER ? 0 : 1) - (b.providerID === DEFAULT_PROVIDER ? 0 : 1) ||
      a.name.localeCompare(b.name),
  );
  return models;
}

export const DEFAULTS = { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };

// One persistent event pump per directory, shared by every browser connection.
// Tracks pending permission asks (they don't replay) and rebroadcasts events
// to all subscribers; new connections get still-pending asks replayed.
const HUB_VERSION = 6; // bump when hub shape/logic changes — old hubs on
// globalThis survive hot reloads and must retire
export async function eventHub(dir: string): Promise<EventHub> {
  let hub = g.hubs.get(dir);
  if (hub?.v === HUB_VERSION) return hub;
  const fresh: EventHub = {
    v: HUB_VERSION,
    subs: new Set(),
    pending: new Map(),
    state: "boot",
    events: 0,
    types: {},
  };
  hub = fresh;
  // Force a fresh subscription (used before starting a run) and resolve once
  // the new one is live, so no early events of the run are missed.
  fresh.resubscribe = () =>
    new Promise((resolve) => {
      fresh.onLive = resolve;
      setTimeout(resolve, 3000); // never block a run on a wedged resubscribe
      fresh.kicked = true;
      try {
        fresh.abort?.abort();
      } catch {}
    });
  g.hubs.set(dir, fresh);
  (async () => {
    for (;;) {
      if (g.hubs.get(dir) !== fresh) return; // replaced by a newer version
      try {
        const { client } = await ocClient(dir); // heals/reboots this dir's server
        // The bus must be directory-scoped (the global bus carries only
        // heartbeats), but a scoped bus belongs to an instance the server
        // disposes after idle. act() calls fresh.resubscribe() before every run
        // so we re-attach to the instance that run wakes.
        fresh.abort = new AbortController();
        const sub = await client.event.subscribe({
          query: { directory: dir },
          signal: fresh.abort.signal,
        });
        fresh.state = "live";
        fresh.onLive?.();
        fresh.onLive = null;
        for await (const raw of sub.stream) {
          const ev = raw as OcEvent;
          fresh.events++;
          fresh.types[ev.type] = (fresh.types[ev.type] ?? 0) + 1;
          const p = ev.properties ?? {};
          if (ev.type === "permission.asked") fresh.pending.set(p.id, ev);
          else if (ev.type === "permission.replied") fresh.pending.delete(p.permissionID);
          else if (ev.type === "session.idle" || ev.type === "session.error") {
            for (const [id, pe] of fresh.pending) {
              if (pe.properties?.sessionID === p.sessionID) fresh.pending.delete(id);
            }
          }
          for (const fn of fresh.subs) {
            try {
              fn(ev);
            } catch {}
          }
        }
      } catch (e) {
        fresh.state = "error: " + String(e instanceof Error ? e.message : e).slice(0, 120);
      }
      if (fresh.state === "live") fresh.state = "reconnecting";
      if (!fresh.kicked) await new Promise((r) => setTimeout(r, 1500));
      fresh.kicked = false;
    }
  })();
  return fresh;
}
