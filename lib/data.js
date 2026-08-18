// Data layer for evepad.
//
// Two adapters behind one shape:
//   local   — reads <project>/.eve/.workflow-data directly (plain files, single-
//             digit ms; eve nests the store under .eve/, so nothing else reads it).
//   vercel  — in-process @workflow/world-vercel client (lib/vercel-client.js).
//             Nothing remote shells out: the workflow CLI costs ~0.91s of boot per
//             spawn and its stream reads tail open streams forever.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveProject, projectsError } from "./projects.js";
import { analyticsFor, readRunEvents, windowFor } from "./vercel-client.js";


export const ENVIRONMENTS = ["local", "preview", "production"];

const dataDir = (path) => join(path, ".eve", ".workflow-data");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const safeList = (d) => (existsSync(d) ? readdirSync(d) : []);
const num = (v) => (v == null ? 0 : Number(v) || 0);


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
//
// Everything remote is in-process via @workflow/world-vercel — the `workflow`
// CLI costs ~0.91s of boot per spawn and its stream reads tail open streams
// forever. The dependency must stay pinned to the beta line eve vendors: 4.x
// clients return an EMPTY LIST against 5.x agents instead of an error.

// No CLI boot, and this exposes the attribute filter the CLI never did.
async function vercelRuns(project, environment, limit, { periodMs, attributes } = {}) {
  const analytics = await analyticsFor(project, environment);
  const res = await analytics.runs.list({
    ...windowFor(periodMs),
    ...(attributes ? { attributes } : {}),
    pagination: { limit: Math.min(limit, 100) },
  });
  return res.data ?? [];
}

// Remote session events, fully in-process (snapshot read + decrypt), so it works
// for OPEN sessions too — same as Vercel's own dashboard.
async function vercelEvents(project, environment, runId) {
  try {
    const events = await readRunEvents(project, environment, runId);
    return { events, note: null };
  } catch (e) {
    return { events: [], note: `Could not read the session stream: ${e.message ?? e}` };
  }
}

async function vercelRun(project, environment, runId) {
  const analytics = await analyticsFor(project, environment);
  return analytics.runs.get(runId);
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

// Remote reads spawn CLI processes, so they are slow enough to be worth caching.
// A terminal run is immutable, so it can be cached indefinitely; anything still
// running gets a short TTL. Local reads are plain file reads and are never cached.
const cache = new Map();
const LIVE_TTL = 4_000;
const DONE_TTL = 6 * 3600_000;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) { cache.delete(key); return null; }
  return hit.data;
}
// Stale-while-revalidate: serve the last known value instantly and refresh in
// the background. Built for the runs list — Vercel's analytics query costs
// ~0.4s at 12h but >5s at 7d, and nobody should stare at a spinner for it.
const inflight = new Map();
async function swrCache(key, ttl, staleTtl, fetcher) {
  const hit = cache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age <= hit.ttl) return hit.data;
  if (hit && age <= staleTtl) {
    if (!inflight.has(key)) {
      inflight.set(key, fetcher()
        .then((data) => cacheSet(key, data, ttl))
        .catch(() => {})
        .finally(() => inflight.delete(key)));
    }
    return hit.data; // stale, but instant — the refresh lands for the next poll
  }
  if (inflight.has(key)) return inflight.get(key).then(() => cache.get(key)?.data ?? fetcher());
  const p = fetcher().then((data) => cacheSet(key, data, ttl)).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
const CACHE_MAX = 200;
function cacheSet(key, data, ttl) {
  // Bounded so a long-lived dev server can't accumulate every run ever viewed.
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), ttl, data });
  return data;
}
const isTerminal = (s) => s === "completed" || s === "failed" || s === "cancelled";

// Mirrors the period set Vercel's Agent Runs uses (and the values its MCP tools take).
const PERIOD_MS = {
  "5m": 3e5, "15m": 9e5, "1h": 36e5, "6h": 6 * 36e5, "12h": 12 * 36e5,
  "1d": 864e5, "3d": 3 * 864e5, "7d": 7 * 864e5, "14d": 14 * 864e5, "30d": 30 * 864e5,
};
export const DEFAULT_PERIOD = "12h";

// `environment` may be a single env or a comma list ("local,production") —
// each env is fetched independently, merged, and every session is tagged with
// the environment it came from so detail links stay unambiguous.
export async function listRuns({ project: name, environment = "local", period = DEFAULT_PERIOD, limit = 100 } = {}) {
  const project = await resolveProject(name);
  if (!project) {
    // A dead token empties the project list, so "no project" is usually the
    // SYMPTOM of an auth failure rather than a missing project. Ask why the
    // listing failed before blaming the name.
    const why = projectsError();
    // env is null, not "vercel": this failure is the whole account, not one
    // environment, and the copy reads it back into a sentence — "your vercel
    // Agent runs" is what a placeholder sentinel looks like once it ships.
    const auth = why ? authFailure([{ env: null, message: why }]) : null;
    return { project: null, environment, period, sessions: [], error: auth ? why : "no project", auth };
  }

  const periodMs = PERIOD_MS[period] ?? PERIOD_MS[DEFAULT_PERIOD];
  const envs = [...new Set(String(environment).split(",").map((e) => e.trim()).filter(Boolean))];
  const errors = [];

  const perEnv = await Promise.all(
    envs.map(async (env) => {
      try {
        let runs;
        if (env === "local") {
          if (!project.localPath) throw new Error("local: no checkout — start `eve dev` for this project");
          runs = localRuns(project.localPath);
        } else {
          // Push the time window server-side so a "Last 15 min" view doesn't
          // transfer and parse 30 days of runs.
          const key = `runs:${project.name}:${env}:${period}:${limit}`;
          // Fresh for 4s; anything younger than 10 min serves instantly while
          // a background refresh replaces it. Only a truly cold key blocks.
          runs = await swrCache(key, LIVE_TTL, 600_000, () =>
            vercelRuns(project, env, limit, { periodMs }));
        }
        return toSessions(runs).map((s) => ({ ...s, environment: env }));
      } catch (e) {
        errors.push({ env, message: String(e.message ?? e) });
        return [];
      }
    }),
  );

  const cutoff = Date.now() - periodMs;
  const sessions = perEnv
    .flat()
    .filter((s) => new Date(s.createdAt).getTime() >= cutoff)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  // Only surface an error when NOTHING was fetchable; a single missing local
  // checkout shouldn't blank a merged view that has production data.
  const failed = sessions.length === 0 && errors.length;
  const error = failed ? errors.map((e) => e.message).join(" · ") : null;
  // Auth is worth naming separately: it's the one failure the user can act on
  // from here, and it's the difference between "reconnect" and "this is broken".
  // Reported even when other environments succeeded — a local-only view that
  // silently stops showing production is worse than a toast.
  return { project, environment, period, sessions, error, auth: authFailure(errors) };
}

// 401 is an expired or revoked token. 403 is NOT the same thing and must not be
// reported as one: the same endpoint returns it for a window past the plan's
// lookback (`observability-upgrade-required`) and for a token that simply can't
// see this team's analytics. Signing in again fixes the first and none of the
// rest, so only 401 — and 403 that names a credential — offers a reconnect.
function authFailure(errors) {
  for (const { env, message } of errors) {
    // Plan first, and without requiring a status code: this arrives as
    // `observability-upgrade-required` and signing in again cannot buy a plan.
    // Checked ahead of the 403 branch it usually rides along with, so it never
    // gets mistaken for a dead credential and sent round a login loop.
    if (/upgrade-required|observability-upgrade|lookback/i.test(message)) {
      return { env, kind: "plan", canReconnect: false, message };
    }
    // No credential at all — same remedy as an expired one, so same offer.
    if (/no vercel cli token|vercel login/i.test(message)) {
      return { env, kind: "missing", canReconnect: true, message };
    }
    if (/\b401\b|unauthorized|invalid token|token.*(expired|revoked)/i.test(message)) {
      return { env, kind: "expired", canReconnect: true, message };
    }
    // Vercel answers a dead CLI token with 403 "Forbidden" as often as 401,
    // so this offers a reconnect — but the copy has to stay a maybe, since the
    // same status covers a token that just can't see this team.
    if (/\b403\b|forbidden/i.test(message)) {
      return { env, kind: "forbidden", canReconnect: true, message };
    }
  }
  return null;
}

// Fold the event log into turns → steps → tool calls. Tool calls exist ONLY here:
// they are never recorded as workflow steps.
function foldEvents(events) {
  const turns = new Map();
  const byCallId = new Map();
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
      for (const a of d.actions ?? []) {
        const call = { callId: a.callId, toolName: a.toolName, kind: a.kind, input: a.input, output: null, status: "pending", startedAt: at, endedAt: null, durationMs: null };
        s.calls.push(call);
        byCallId.set(a.callId, call);
      }
    } else if (e.type === "action.result") {
      // Index lookup, not a scan over every turn/step — results arrive one per call.
      const r = d.result ?? {};
      const c = byCallId.get(r.callId);
      if (c) {
        c.output = r.output;
        c.status = d.status ?? "completed";
        c.endedAt = at;
        if (c.startedAt && at) c.durationMs = new Date(at) - new Date(c.startedAt);
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

export async function getRun(runId, { project: name, environment = "local", fresh = false } = {}) {
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

  const key = `run:${project.name}:${environment}:${runId}`;
  const cached = fresh ? undefined : cacheGet(key);
  if (cached) return cached;

  // These three are independent, so run them concurrently rather than in sequence —
  // each one pays Node startup plus a network round trip.
  const [run, recent, streamResult] = await Promise.all([
    vercelRun(project, environment, runId),
    // Ask the server for exactly this session's descendants instead of pulling a
    // page of 100 recent runs and filtering client-side.
    vercelRuns(project, environment, 50, { attributes: { "$eve.root": runId } }).catch(() => []),
    vercelEvents(project, environment, runId).catch((e) => ({
      events: [],
      note: `Could not read the remote session stream: ${e.message ?? e}`,
    })),
  ]);
  if (!run) return null;
  const { events, note } = streamResult;

  const childRuns = recent
    .filter((r) => r.attributes?.["$eve.parent"] === runId || r.attributes?.["$eve.root"] === runId)
    .map((k) => ({ runId: k.runId, workflowName: k.workflowName, status: k.status, attributes: k.attributes ?? {} }));

  const result = {
    environment,
    session: { runId: run.runId, status: run.status, createdAt: run.createdAt, attributes: run.attributes ?? {} },
    childRuns,
    turns: foldEvents(events),
    events: events.map((e) => ({ type: e.type, at: e.meta?.at, data: e.data })),
    note,
  };

  return cacheSet(key, result, isTerminal(run.status) ? DONE_TTL : LIVE_TTL);
}
