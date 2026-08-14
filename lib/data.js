// Data layer for the eve cockpit.
//
// Two adapters behind one shape:
//   local   — reads <project>/.eve/.workflow-data directly. The `workflow` CLI's
//             local backend can't be used: it expects .workflow-data at the project
//             root, while eve nests it under .eve/.
//   vercel  — shells out to `workflow inspect ... -b vercel -e <env>`. Must run with
//             cwd set to a directory containing .vercel/ or the API 403s, even when
//             --project/--team are passed explicitly.

import { readFileSync, readdirSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveProject, ensureLinkDir, TEAM } from "./projects.js";

const exec = promisify(execFile);

export const ENVIRONMENTS = ["local", "preview", "production"];

const dataDir = (path) => join(path, ".eve", ".workflow-data");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const safeList = (d) => (existsSync(d) ? readdirSync(d) : []);
const num = (v) => (v == null ? 0 : Number(v) || 0);

// The CLI needs *some* cwd; when a project has no local checkout the explicit
// WORKFLOW_VERCEL_* env vars carry project and team instead.
let scratchCwd = null;
const neutralCwd = () => (scratchCwd ??= mkdtempSync(join(tmpdir(), "eve-cockpit-")));

// --- local adapter --------------------------------------------------------

// Chunk files are devalue-wrapped base64 holding one NDJSON event.
function decodeChunk(file) {
  const raw = readFileSync(file, "latin1");
  const m = raw.match(/"([A-Za-z0-9+/]{40,}={0,2})"/);
  if (!m) return null;
  try { return JSON.parse(Buffer.from(m[1], "base64").toString("utf8")); } catch { return null; }
}

// streams/runs/<runId>.json lists stream names. The stream id drops the `wrun_`
// prefix (strm_<ulid>_user) — never derive it from the run id.
function streamNames(runId, project) {
  const manifest = join(dataDir(project), "streams", "runs", `${runId}.json`);
  if (existsSync(manifest)) {
    try {
      const m = readJson(manifest);
      if (Array.isArray(m.streams) && m.streams.length) return m.streams;
    } catch {}
  }
  return [`strm_${runId.replace(/^wrun_/, "")}_user`];
}

function localEvents(runId, project) {
  const out = [];
  for (const name of streamNames(runId, project)) {
    const dir = join(dataDir(project), "streams", "chunks", name);
    for (const f of safeList(dir).sort()) {
      const ev = decodeChunk(join(dir, f));
      if (ev) out.push(ev);
    }
  }
  return out.sort((a, b) => String(a.meta?.id ?? "").localeCompare(String(b.meta?.id ?? "")));
}

function localRuns(project) {
  return safeList(join(dataDir(project), "runs"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => { try { return readJson(join(dataDir(project), "runs", f)); } catch { return null; } })
    .filter(Boolean);
}

// --- vercel adapter -------------------------------------------------------

// The CLI must match the runtime's major version. `workflow@latest` (4.x) talks to
// an older API and returns an EMPTY LIST rather than an error against 5.x agents —
// a silent failure. Keep this pinned to the beta line that eve vendors.
async function workflowCli(args, project) {
  const bin = join(process.cwd(), "node_modules", ".bin", "workflow");
  const env = { ...process.env, DEBUG: "" };
  if (project?.name) env.WORKFLOW_VERCEL_PROJECT = project.name;
  if (TEAM) env.WORKFLOW_VERCEL_TEAM = TEAM;

  const { stdout } = await exec(bin, args, {
    cwd: await ensureLinkDir(project),
    maxBuffer: 64 * 1024 * 1024,
    env,
  });
  // The CLI prints a banner and log lines before the JSON payload.
  const i = stdout.search(/^[[{]/m);
  if (i === -1) throw new Error("no JSON in CLI output");
  return JSON.parse(stdout.slice(i));
}

async function vercelRuns(project, environment, limit) {
  const res = await workflowCli(
    ["inspect", "runs", "-j", "-b", "vercel", "-e", environment, "--limit", String(limit)],
    project,
  );
  return Array.isArray(res) ? res : res.data ?? [];
}

async function vercelRun(project, environment, runId) {
  const res = await workflowCli(
    ["inspect", "run", runId, "-j", "-b", "vercel", "-e", environment],
    project,
  );
  return Array.isArray(res) ? res[0] : res.data ?? res;
}

// --- normalization --------------------------------------------------------

// Sessions are the user-facing unit; turns and subagents hang off them.
// Housekeeping runs (sessionTimeoutWorkflow) carry no $eve.type — drop them.
function toSessions(runs) {
  const typed = runs.filter((r) => r?.attributes?.["$eve.type"]);
  const sessions = typed.filter((r) => r.attributes["$eve.type"] === "session");
  const children = typed.filter((r) => r.attributes["$eve.type"] !== "session");

  return sessions
    .map((s) => {
      const kids = children.filter(
        (c) => c.attributes["$eve.parent"] === s.runId || c.attributes["$eve.root"] === s.runId,
      );
      const roll = (k) => kids.reduce((sum, c) => sum + num(c.attributes[k]), 0);
      const end = s.completedAt ?? kids.map((k) => k.completedAt).filter(Boolean).sort().pop();
      return {
        runId: s.runId,
        title: s.attributes["$eve.title"] ?? "(untitled)",
        trigger: s.attributes["$eve.trigger"] ?? "—",
        status: s.status,
        createdAt: s.createdAt,
        durationMs: end ? new Date(end) - new Date(s.createdAt) : null,
        model: kids.find((k) => k.attributes["$eve.model"])?.attributes["$eve.model"] ?? null,
        turns: kids.filter((c) => c.attributes["$eve.type"] === "turn").length,
        subagents: kids.filter((c) => c.attributes["$eve.type"] === "subagent").length,
        costUsd: roll("$eve.cost_usd"),
        inputTokens: roll("$eve.input_tokens"),
        outputTokens: roll("$eve.output_tokens"),
        cacheReadTokens: roll("$eve.cache_read_tokens"),
        cacheWriteTokens: roll("$eve.cache_write_tokens"),
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

const PERIOD_MS = {
  "1h": 36e5, "6h": 6 * 36e5, "1d": 864e5,
  "7d": 7 * 864e5, "30d": 30 * 864e5, all: Infinity,
};

export async function listRuns({ project: name, environment = "local", period = "7d", limit = 100 } = {}) {
  const project = await resolveProject(name);
  if (!project) return { project: null, environment, period, sessions: [], error: "no project" };

  let runs = [];
  let error = null;
  try {
    if (environment === "local") {
      if (!project.localPath) throw new Error("no local checkout — start `eve dev` for this project");
      runs = localRuns(project.localPath);
    } else {
      runs = await vercelRuns(project, environment, limit);
    }
  } catch (e) {
    error = String(e.message ?? e);
  }
  const cutoff = Date.now() - (PERIOD_MS[period] ?? PERIOD_MS["7d"]);
  const sessions = toSessions(runs).filter((s) => new Date(s.createdAt).getTime() >= cutoff);
  return { project, environment, period, sessions, error };
}

// Fold the event log into turns → steps → tool calls. Tool calls exist ONLY here:
// they are never recorded as workflow steps.
function foldEvents(events) {
  const turns = new Map();
  const turnOf = (id) => {
    if (!turns.has(id)) turns.set(id, { turnId: id, steps: new Map(), messages: [], startedAt: null, endedAt: null });
    return turns.get(id);
  };
  const stepOf = (t, i) => {
    if (!t.steps.has(i)) t.steps.set(i, { stepIndex: i, calls: [], usage: null, finishReason: null, generationId: null });
    return t.steps.get(i);
  };

  for (const e of events) {
    const d = e.data ?? {};
    const at = e.meta?.at ?? null;
    if (d.turnId == null) continue;
    const t = turnOf(d.turnId);
    if (e.type === "turn.started") t.startedAt = at;
    if (e.type === "turn.completed") t.endedAt = at;

    if (e.type === "actions.requested") {
      const s = stepOf(t, d.stepIndex ?? 0);
      for (const a of d.actions ?? [])
        s.calls.push({ callId: a.callId, toolName: a.toolName, kind: a.kind, input: a.input, output: null, status: "pending", startedAt: at, endedAt: null, durationMs: null });
    } else if (e.type === "action.result") {
      const r = d.result ?? {};
      for (const [, tt] of turns)
        for (const [, s] of tt.steps) {
          const c = s.calls.find((c) => c.callId === r.callId);
          if (c) {
            c.output = r.output; c.status = d.status ?? "completed"; c.endedAt = at;
            if (c.startedAt && at) c.durationMs = new Date(at) - new Date(c.startedAt);
          }
        }
    } else if (e.type === "step.completed") {
      const s = stepOf(t, d.stepIndex ?? 0);
      s.usage = d.usage ?? null;
      s.finishReason = d.finishReason ?? null;
      s.generationId = d.providerMetadata?.gateway?.generationId ?? null;
    } else if (e.type === "message.received" || e.type === "message.completed") {
      t.messages.push({ type: e.type, at, text: extractText(d) });
    }
  }

  return [...turns.values()].map((t) => ({
    ...t,
    steps: [...t.steps.values()].sort((a, b) => a.stepIndex - b.stepIndex),
    durationMs: t.startedAt && t.endedAt ? new Date(t.endedAt) - new Date(t.startedAt) : null,
  }));
}

function extractText(d) {
  const m = d.message ?? d.content ?? d;
  if (typeof m === "string") return m;
  if (Array.isArray(m)) return m.filter((p) => p?.type === "text").map((p) => p.text).join("");
  if (typeof m?.text === "string") return m.text;
  return null;
}

export async function getRun(runId, { project: name, environment = "local" } = {}) {
  const project = await resolveProject(name);
  if (!project) return null;

  if (environment === "local") {
    if (!project.localPath) return null;
    const runs = localRuns(project.localPath);
    const session = runs.find((r) => r.runId === runId);
    if (!session) return null;
    const kids = runs.filter(
      (r) => r.attributes?.["$eve.parent"] === runId || r.attributes?.["$eve.root"] === runId,
    );
    const events = localEvents(runId, project.localPath);
    return {
      environment,
      session: { runId: session.runId, status: session.status, createdAt: session.createdAt, attributes: session.attributes ?? {} },
      childRuns: kids.map((k) => ({ runId: k.runId, workflowName: k.workflowName, status: k.status, attributes: k.attributes ?? {} })),
      turns: foldEvents(events),
      events: events.map((e) => ({ type: e.type, at: e.meta?.at, data: e.data })),
      note: null,
    };
  }

  // Remote: run metadata and attributes come back from the CLI, but the session
  // event stream (and therefore tool-call detail) is not exposed by it yet.
  const run = await vercelRun(project, environment, runId);
  if (!run) return null;
  return {
    environment,
    session: { runId: run.runId, status: run.status, createdAt: run.createdAt, attributes: run.attributes ?? {} },
    childRuns: [],
    turns: [],
    events: [],
    note: "Remote runs show metadata and attributes only — the session event stream that carries tool calls is not exposed by `workflow inspect`.",
  };
}
