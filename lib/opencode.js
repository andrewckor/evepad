// OpenCode engine for Build chat: a real, battle-tested coding agent running
// LOCALLY against the checkout via @opencode-ai/sdk.
//
// Why not HarnessAgent: the AI SDK harness layer is cloud-sandbox-only today
// (every session requires a HarnessV1SandboxSession; no local provider exists).
// This module is the swap point — when a local provider ships, HarnessAgent
// replaces the internals without touching the route or UI.
//
// Guardrails come from OpenCode's own permission system: edits allowed inside
// the project, external_directory denied. bash stays enabled deliberately —
// that's the robustness (typecheck, ls, grep) the hand-rolled loop lacked.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createOpencodeServer, createOpencodeClient } from "@opencode-ai/sdk";

const exec = promisify(execFile);
const DEFAULT_PROVIDER = "vercel";
const DEFAULT_MODEL = "zai/glm-5.2";

const g = (globalThis.__eveCockpitOpencode ??= { server: null, client: null, sessions: new Map(), hubs: new Map() });

function readOidc(dir) {
  try {
    return readFileSync(join(dir, ".env.local"), "utf8").match(/^VERCEL_OIDC_TOKEN="?([^"\n]+)"?/m)?.[1] ?? null;
  } catch { return null; }
}
const isExpired = (t) => {
  try { return JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()).exp * 1000 < Date.now() + 60_000; }
  catch { return true; }
};
export async function freshOidc(dir) {
  let t = readOidc(dir);
  if (!t || isExpired(t)) {
    try {
      await exec("vercel", ["env", "pull", ".env.local", "--yes"], { cwd: dir, timeout: 60_000 });
      t = readOidc(dir);
    } catch {}
  }
  return t && !isExpired(t) ? t : null;
}

async function ensureServer(oidc) {
  // The server process captures env at boot; refresh cheaply by rebooting when
  // the auth token rotates (tokens live ~12h, reboot takes ~2s).
  if (g.server && g.bootToken === oidc) {
    // Handles survive hot reloads on globalThis but the process behind them
    // may be gone — verify liveness before trusting the cached server.
    try {
      const ok = await fetch(`${g.server.url}/app`, { signal: AbortSignal.timeout(1500) });
      if (ok.ok) return;
    } catch {}
  }
  if (g.server) { try { g.server.close(); } catch {} g.server = null; g.sessions.clear(); }
  for (const hub of (g.hubs ??= new Map()).values()) hub.pending.clear();
  process.env.VERCEL_OIDC_TOKEN = oidc;
  // createOpencodeServer spawns the `opencode` binary from PATH — ours lives
  // in this app's node_modules/.bin (via the opencode-ai package).
  const bin = join(process.cwd(), "node_modules", ".bin");
  if (!process.env.PATH?.includes(bin)) process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  // The SDK's default port (4096) collides with any prior/orphaned server and
  // opencode dies with an opaque ServeError — always pick a free port.
  const { createServer } = await import("node:net");
  const port = await new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
  g.server = await createOpencodeServer({
    hostname: "127.0.0.1",
    port,
    timeout: 15_000,
    config: {
      // Server-side default model — the attached TUI inherits this too.
      model: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
      // Master prompt: what an eve agent is, its file anatomy, and the
      // working rules. Injected into every session on this server.
      instructions: [join(process.cwd(), "lib", "eve-agent-prompt.md")],
      permission: { edit: "allow", bash: "ask", webfetch: "allow", external_directory: "deny" },
      // Vercel AI Gateway as a real provider: opencode loads @ai-sdk/gateway,
      // which auto-authenticates from VERCEL_OIDC_TOKEN in the server env —
      // same free-GLM path as the rest of the cockpit.
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
  g.client = createOpencodeClient({ baseUrl: g.server.url });
  g.bootToken = oidc;

  // Never orphan the opencode server: close it when the cockpit process dies
  // (an orphan holding its port is exactly how this integration first broke).
  if (!g.cleanupInstalled) {
    g.cleanupInstalled = true;
    const shutdown = () => { try { g.server?.close(); } catch {} };
    process.on("exit", shutdown);
    for (const sig of ["SIGINT", "SIGTERM"]) {
      process.on(sig, () => { shutdown(); process.exit(0); });
    }
  }
}

// Boot (or reuse) the shared server and hand back its URL — the TUI attaches
// to this same server, so terminal and Build chat see the same sessions.
export async function opencodeServerUrl(dir) {
  const oidc = await freshOidc(dir);
  if (!oidc) throw new Error("No AI Gateway credentials for this project.");
  await ensureServer(oidc);
  return g.server.url;
}

// Every model the booted opencode server can route to (our Vercel AI Gateway
// provider + opencode's built-ins), flattened for the chat's model picker.
export async function listModels(project) {
  const oidc = await freshOidc(project.localPath);
  if (!oidc) throw new Error("No AI Gateway credentials for this project.");
  await ensureServer(oidc);
  const res = await g.client.config.providers({ throwOnError: true });
  const models = [];
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
  models.sort((a, b) =>
    (a.providerID === DEFAULT_PROVIDER ? 0 : 1) - (b.providerID === DEFAULT_PROVIDER ? 0 : 1) ||
    a.name.localeCompare(b.name));
  return models;
}

// The raw SDK client for a project checkout — the /api/oc/* routes are thin
// passthroughs over this. Boots/heals the shared server on demand.
export async function ocClient(dir) {
  const oidc = await freshOidc(dir);
  if (!oidc) throw new Error("No AI Gateway credentials — press play once or run `vercel env pull`.");
  await ensureServer(oidc);
  return { client: g.client, dir };
}

export const DEFAULTS = { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };

// One persistent event pump per directory, shared by every browser connection.
// Without this, a permission.asked that fires during a page reload or stream
// reconnect is lost forever (asks don't replay) and the run wedges silently.
// The hub tracks pending asks and replays them to each new subscriber.
const HUB_VERSION = 2; // bump when hub shape/logic changes — old hubs on
                       // globalThis survive hot reloads and must retire
export async function eventHub(dir) {
  g.hubs ??= new Map(); // singleton may predate this field across hot reloads
  let hub = g.hubs.get(dir);
  if (hub?.v === HUB_VERSION) return hub;
  hub = { v: HUB_VERSION, subs: new Set(), pending: new Map(), state: "boot", events: 0 };
  g.hubs.set(dir, hub);
  (async () => {
    for (;;) {
      if (g.hubs.get(dir) !== hub) return; // replaced by a newer version
      try {
        const { client } = await ocClient(dir); // heals/reboots the server too
        const sub = await client.event.subscribe({ query: { directory: dir } });
        hub.state = "live";
        for await (const ev of sub.stream) {
          hub.events++;
          const p = ev.properties ?? {};
          if (ev.type === "permission.asked") hub.pending.set(p.id, ev);
          else if (ev.type === "permission.replied") hub.pending.delete(p.permissionID);
          else if (ev.type === "session.idle" || ev.type === "session.error") {
            for (const [id, pe] of hub.pending) {
              if (pe.properties?.sessionID === p.sessionID) hub.pending.delete(id);
            }
          }
          for (const fn of hub.subs) { try { fn(ev); } catch {} }
        }
      } catch (e) { hub.state = "error: " + String(e?.message ?? e).slice(0, 120); }
      if (hub.state === "live") hub.state = "reconnecting";
      await new Promise((r) => setTimeout(r, 1500));
    }
  })();
  return hub;
}
