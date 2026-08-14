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

const g = (globalThis.__eveCockpitOpencode ??= { server: null, client: null, sessions: new Map() });

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
      permission: { edit: "allow", bash: "allow", webfetch: "allow", external_directory: "deny" },
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

// Snapshot the agent surface so ANY engine's edits produce revert chips.
export function snapshotAgent(dir) {
  const snap = new Map();
  const add = (p) => { try { snap.set(p, readFileSync(join(dir, p), "utf8")); } catch {} };
  add("agent/agent.ts");
  add("agent/instructions.md");
  try {
    for (const f of readdirSync(join(dir, "agent", "tools"))) {
      if (/\.(ts|js)$/.test(f)) add(`agent/tools/${f}`);
    }
  } catch {}
  return snap;
}
export function diffAgent(dir, before) {
  const after = snapshotAgent(dir);
  const writes = [];
  for (const [path, content] of after) {
    const prev = before.get(path);
    if (prev === undefined) writes.push({ path, previous: null });
    else if (prev !== content) writes.push({ path, previous: prev });
  }
  for (const [path, prev] of before) {
    if (!after.has(path)) writes.push({ path, previous: prev, deleted: true });
  }
  return writes;
}

export async function opencodePrompt(project, userText, { provider, model } = {}) {
  const dir = project.localPath;
  const oidc = await freshOidc(dir);
  if (!oidc) throw new Error("No AI Gateway credentials for this project.");
  await ensureServer(oidc);

  let sessionId = g.sessions.get(project.name);
  if (!sessionId) {
    const created = await g.client.session.create({
      query: { directory: dir },
      body: { title: `cockpit build: ${project.name}` },
      throwOnError: true,
    });
    sessionId = created.data.id;
    g.sessions.set(project.name, sessionId);
  }

  return promptSession(sessionId, dir, userText, { provider, model });
}

function toolEvent(part, dir) {
  const input = part.state?.input ?? {};
  const file = input.filePath ?? input.path;
  return {
    tool: part.tool ?? "tool",
    path: file ? String(file).replace(`${dir}/`, "")
      : input.command ? String(input.command).slice(0, 60)
      : input.pattern ?? undefined,
  };
}

async function promptSession(sessionId, dir, userText, { provider, model } = {}, onFrame) {
  // Live progress rides the server's event bus: text arrives as deltas and
  // tool calls as part updates, filtered to this session. onFrame is optional —
  // without it this degrades to the blocking call.
  const abort = new AbortController();
  const emitted = new Set(); // part ids already surfaced as tool events
  const events = [];
  let pump = null;
  if (onFrame) {
    pump = (async () => {
      // The bus is directory-scoped — without query.directory it only ever
      // says server.connected. Deltas arrive as their own event type carrying
      // just partID, so track part types from part.updated and forward only
      // text-part deltas (GLM streams its reasoning the same way).
      const partTypes = new Map();
      try {
        const sub = await g.client.event.subscribe({ query: { directory: dir }, signal: abort.signal });
        for await (const ev of sub.stream) {
          const p = ev.properties;
          if (ev.type === "message.part.updated" && p?.part?.sessionID === sessionId) {
            const part = p.part;
            partTypes.set(part.id, part.type);
            if (part.type === "tool" && Object.keys(part.state?.input ?? {}).length && !emitted.has(part.id)) {
              emitted.add(part.id);
              const e = toolEvent(part, dir);
              events.push(e);
              onFrame({ type: "tool", ...e });
            }
          } else if (ev.type === "message.part.delta" && p?.sessionID === sessionId) {
            if (p.field === "text" && p.delta && partTypes.get(p.partID) === "text") {
              onFrame({ type: "delta", text: p.delta });
            }
          }
        }
      } catch {} // aborting the subscription is the normal exit
    })();
  }

  const beforeMsgs = onFrame ? null : await g.client.session.messages({
    path: { id: sessionId }, query: { directory: dir }, throwOnError: true,
  });

  try {
    const res = await g.client.session.prompt({
      path: { id: sessionId },
      query: { directory: dir },
      body: {
        model: { providerID: provider ?? DEFAULT_PROVIDER, modelID: model ?? DEFAULT_MODEL },
        parts: [{ type: "text", text: userText }],
      },
      throwOnError: true,
    });
    const text = (res.data?.parts ?? [])
      .filter((p) => p.type === "text").map((p) => p.text).join("\n").trim();

    if (onFrame) return { text, events };

    // Non-streaming path: harvest tool parts from every message this turn
    // produced (they live in intermediate assistant messages, not the final).
    const prevIds = new Set(beforeMsgs.data.map((m) => m.info.id));
    const afterMsgs = await g.client.session.messages({
      path: { id: sessionId }, query: { directory: dir }, throwOnError: true,
    });
    const harvested = afterMsgs.data
      .filter((m) => m.info.role === "assistant" && !prevIds.has(m.info.id))
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "tool")
      .map((p) => toolEvent(p, dir));
    return { text, events: harvested };
  } finally {
    abort.abort();
    await pump;
  }
}

export async function opencodePromptStream(project, userText, opts, onFrame) {
  const dir = project.localPath;
  const oidc = await freshOidc(dir);
  if (!oidc) throw new Error("No AI Gateway credentials for this project.");
  await ensureServer(oidc);

  let sessionId = g.sessions.get(project.name);
  if (!sessionId) {
    const created = await g.client.session.create({
      query: { directory: dir },
      body: { title: `cockpit build: ${project.name}` },
      throwOnError: true,
    });
    sessionId = created.data.id;
    g.sessions.set(project.name, sessionId);
  }
  return promptSession(sessionId, dir, userText, opts ?? {}, onFrame);
}

export function resetOpencodeSession(name) {
  g.sessions.delete(name);
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
