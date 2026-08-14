#!/usr/bin/env node
// eve cockpit — a single-pane view of local eve agent runs.
// Usage: node cockpit.mjs [path-to-agent-project] [--port 5173]
//
// Reads <project>/.eve/.workflow-data:
//   runs/*.json                    structure, status, $eve.* attributes
//   streams/chunks/strm_<runId>_user/*.bin   the full session event log
// Tool calls live only in the stream, never in steps — so both are merged here.

import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const portFlag = args.indexOf("--port");
const PORT = portFlag !== -1 ? Number(args[portFlag + 1]) : 5173;
const PROJECT = resolve(args.find((a) => !a.startsWith("--") && a !== String(PORT)) ?? ".");
const DATA = join(PROJECT, ".eve", ".workflow-data");

if (!existsSync(DATA)) {
  console.error(`No workflow store at ${DATA}`);
  console.error(`Point me at an eve project that has been run at least once:`);
  console.error(`  node cockpit.mjs ~/path/to/agent`);
  process.exit(1);
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const safeList = (dir) => (existsSync(dir) ? readdirSync(dir) : []);

// Chunk files are devalue-wrapped base64 of one NDJSON event.
function decodeChunk(file) {
  const raw = readFileSync(file, "latin1");
  const m = raw.match(/"([A-Za-z0-9+/]{40,}={0,2})"/);
  if (!m) return null;
  try {
    return JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
  } catch {
    return null;
  }
}

// streams/runs/<runId>.json lists the run's stream names. The stream id drops
// the `wrun_` prefix (strm_<ulid>_user), so never derive it from the run id.
function streamNames(runId) {
  const manifest = join(DATA, "streams", "runs", `${runId}.json`);
  if (existsSync(manifest)) {
    try {
      const m = readJson(manifest);
      if (Array.isArray(m.streams) && m.streams.length) return m.streams;
    } catch {}
  }
  return [`strm_${runId.replace(/^wrun_/, "")}_user`];
}

// Chunk ids are ULIDs, so filename order is chronological.
function eventsFor(runId) {
  const out = [];
  for (const name of streamNames(runId)) {
    const dir = join(DATA, "streams", "chunks", name);
    for (const f of safeList(dir).sort()) {
      const ev = decodeChunk(join(dir, f));
      if (ev) out.push(ev);
    }
  }
  return out.sort((a, b) => String(a.meta?.id ?? "").localeCompare(String(b.meta?.id ?? "")));
}

function allRuns() {
  return safeList(join(DATA, "runs"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return readJson(join(DATA, "runs", f));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const num = (v) => (v == null ? 0 : Number(v) || 0);

// Sessions are the user-facing unit. Turns hang off them via $eve.parent.
// Housekeeping runs (sessionTimeoutWorkflow) carry no $eve.type — drop them.
function buildSessions() {
  const runs = allRuns();
  const typed = runs.filter((r) => r.attributes?.["$eve.type"]);
  const sessions = typed.filter((r) => r.attributes["$eve.type"] === "session");
  const children = typed.filter((r) => r.attributes["$eve.type"] !== "session");

  return sessions
    .map((s) => {
      const kids = children.filter(
        (c) =>
          c.attributes["$eve.parent"] === s.runId ||
          c.attributes["$eve.root"] === s.runId,
      );
      const roll = (k) => kids.reduce((sum, c) => sum + num(c.attributes[k]), 0);
      return {
        runId: s.runId,
        title: s.attributes["$eve.title"] ?? "(untitled)",
        trigger: s.attributes["$eve.trigger"] ?? "?",
        status: s.status,
        createdAt: s.createdAt,
        model: kids[0]?.attributes["$eve.model"] ?? null,
        turns: kids.filter((c) => c.attributes["$eve.type"] === "turn").length,
        subagents: kids.filter((c) => c.attributes["$eve.type"] === "subagent").length,
        costUsd: roll("$eve.cost_usd"),
        inputTokens: roll("$eve.input_tokens"),
        outputTokens: roll("$eve.output_tokens"),
        cacheReadTokens: roll("$eve.cache_read_tokens"),
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function sessionDetail(runId) {
  const runs = allRuns();
  const session = runs.find((r) => r.runId === runId);
  if (!session) return null;
  const kids = runs.filter(
    (r) =>
      r.attributes?.["$eve.parent"] === runId ||
      r.attributes?.["$eve.root"] === runId,
  );
  const events = eventsFor(runId);

  // Fold the event log into turns → steps → tool calls.
  const turns = new Map();
  const turnOf = (id) => {
    if (!turns.has(id)) turns.set(id, { turnId: id, steps: new Map(), messages: [] });
    return turns.get(id);
  };
  const stepOf = (t, i) => {
    if (!t.steps.has(i)) t.steps.set(i, { stepIndex: i, calls: [], usage: null, finishReason: null });
    return t.steps.get(i);
  };

  for (const e of events) {
    const d = e.data ?? {};
    const t = d.turnId != null ? turnOf(d.turnId) : null;
    if (!t) continue;
    if (e.type === "actions.requested") {
      const s = stepOf(t, d.stepIndex ?? 0);
      for (const a of d.actions ?? []) {
        s.calls.push({ callId: a.callId, toolName: a.toolName, kind: a.kind, input: a.input, output: null, status: "pending" });
      }
    } else if (e.type === "action.result") {
      const r = d.result ?? {};
      for (const [, tt] of turns)
        for (const [, s] of tt.steps) {
          const c = s.calls.find((c) => c.callId === r.callId);
          if (c) { c.output = r.output; c.status = d.status ?? "completed"; }
        }
    } else if (e.type === "step.completed") {
      const s = stepOf(t, d.stepIndex ?? 0);
      s.usage = d.usage ?? null;
      s.finishReason = d.finishReason ?? null;
      s.generationId = d.providerMetadata?.gateway?.generationId ?? null;
    } else if (e.type === "message.completed" || e.type === "message.received") {
      t.messages.push({ type: e.type, at: e.meta?.at, data: d });
    }
  }

  return {
    session: {
      runId: session.runId,
      status: session.status,
      createdAt: session.createdAt,
      attributes: session.attributes ?? {},
    },
    childRuns: kids.map((k) => ({
      runId: k.runId,
      workflowName: k.workflowName,
      status: k.status,
      attributes: k.attributes ?? {},
    })),
    turns: [...turns.values()].map((t) => ({
      turnId: t.turnId,
      messages: t.messages,
      steps: [...t.steps.values()].sort((a, b) => a.stepIndex - b.stepIndex),
    })),
    eventCount: events.length,
    events: events.map((e) => ({ type: e.type, at: e.meta?.at, data: e.data })),
  };
}

// --- server ---------------------------------------------------------------

const json = (res, body) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/runs") return json(res, { project: PROJECT, sessions: buildSessions() });

  if (url.pathname.startsWith("/api/run/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/run/".length));
    const d = sessionDetail(id);
    if (!d) { res.writeHead(404); return res.end("no such run"); }
    return json(res, d);
  }

  // Cheap liveness signal: newest mtime across the store.
  if (url.pathname === "/api/pulse") {
    let newest = 0;
    for (const sub of ["runs", "steps", "events"]) {
      for (const f of safeList(join(DATA, sub))) {
        try { newest = Math.max(newest, statSync(join(DATA, sub, f)).mtimeMs); } catch {}
      }
    }
    return json(res, { newest });
  }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`eve cockpit  →  http://127.0.0.1:${PORT}`);
  console.log(`watching      ${DATA}`);
});

const PAGE = /* html */ `<!doctype html><meta charset="utf-8">
<title>eve cockpit</title>
<style>
  :root{--bg:#0b0c0e;--panel:#131519;--line:#23262d;--fg:#e6e8eb;--dim:#8b919b;--acc:#5b9dff;--ok:#3fb950;--bad:#f85149;--warn:#d29922}
  *{box-sizing:border-box}
  body{margin:0;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);color:var(--fg);height:100vh;display:grid;grid-template-columns:380px 1fr}
  #list{border-right:1px solid var(--line);overflow-y:auto}
  #detail{overflow-y:auto;padding:18px 22px}
  h1{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--dim);margin:0;padding:14px 16px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);display:flex;justify-content:space-between}
  .run{padding:11px 16px;border-bottom:1px solid var(--line);cursor:pointer}
  .run:hover{background:var(--panel)}
  .run.sel{background:var(--panel);box-shadow:inset 3px 0 0 var(--acc)}
  .title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:5px}
  .meta{color:var(--dim);font-size:11px;display:flex;gap:10px;flex-wrap:wrap}
  .pill{border:1px solid var(--line);border-radius:10px;padding:0 7px;font-size:11px;color:var(--dim)}
  .ok{color:var(--ok)}.bad{color:var(--bad)}.run-ing{color:var(--warn)}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px;margin-bottom:14px}
  .k{color:var(--dim)}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:6px 18px}
  .step{border-left:2px solid var(--line);padding:2px 0 2px 14px;margin:12px 0}
  .tool{background:#0e1014;border:1px solid var(--line);border-radius:6px;padding:9px 11px;margin:7px 0}
  .tname{color:var(--acc)}
  pre{margin:5px 0 0;white-space:pre-wrap;word-break:break-word;color:#c8ccd4;font-size:12px}
  details summary{cursor:pointer;color:var(--dim);font-size:12px}
  .empty{color:var(--dim);padding:40px 22px}
</style>
<div id="list">
  <h1><span id="proj" title="watched project">runs</span><span id="live" class="k">·</span></h1>
  <div id="runs"></div>
</div>
<div id="detail"><div class="empty">Select a run.</div></div>
<script>
let sel=null, lastPulse=0;
const money=n=>'$'+(n||0).toFixed(4);
const esc=s=>String(s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
const cls=s=>s==='completed'?'ok':s==='failed'?'bad':'run-ing';

async function loadRuns(){
  const r=await (await fetch('/api/runs')).json();
  const p=document.getElementById('proj');
  p.textContent=r.project.split('/').pop(); p.title=r.project;
  document.getElementById('runs').innerHTML=r.sessions.map(s=>\`
    <div class="run \${s.runId===sel?'sel':''}" onclick="pick('\${s.runId}')">
      <div class="title">\${esc(s.title)}</div>
      <div class="meta">
        <span class="\${cls(s.status)}">\${s.status}</span>
        <span>\${s.trigger}</span>
        <span>\${s.turns} turn\${s.turns===1?'':'s'}</span>
        \${s.subagents?'<span>'+s.subagents+' sub</span>':''}
        <span>\${money(s.costUsd)}</span>
      </div>
    </div>\`).join('') || '<div class="empty">No runs yet. Talk to your agent.</div>';
}

async function pick(id){
  sel=id; loadRuns();
  const d=await (await fetch('/api/run/'+id)).json();
  const a=d.session.attributes;
  const turns=d.turns.map(t=>\`
    <div class="card">
      <div style="margin-bottom:8px"><span class="k">turn</span> \${esc(t.turnId)}</div>
      \${t.steps.map(s=>\`
        <div class="step">
          <div class="meta"><span>step \${s.stepIndex}</span>
            \${s.finishReason?'<span class="pill">'+esc(s.finishReason)+'</span>':''}
            \${s.usage?'<span>'+money(s.usage.costUsd)+'</span><span>'+s.usage.inputTokens+' in / '+s.usage.outputTokens+' out</span>':''}
            \${s.generationId?'<span class="k">'+esc(s.generationId)+'</span>':''}
          </div>
          \${s.calls.map(c=>\`
            <div class="tool">
              <div><span class="tname">\${esc(c.toolName)}</span> <span class="k">\${esc(c.status)}</span></div>
              <pre>← \${esc(JSON.stringify(c.input))}</pre>
              \${c.output!=null?'<pre>→ '+esc(JSON.stringify(c.output))+'</pre>':''}
            </div>\`).join('')}
        </div>\`).join('')}
    </div>\`).join('');

  document.getElementById('detail').innerHTML=\`
    <div class="card">
      <div class="title" style="font-size:15px;margin-bottom:10px">\${esc(a['$eve.title']||d.session.runId)}</div>
      <div class="grid">
        <div><span class="k">run</span> \${esc(d.session.runId)}</div>
        <div><span class="k">status</span> <span class="\${cls(d.session.status)}">\${d.session.status}</span></div>
        <div><span class="k">model</span> \${esc(d.childRuns.find(c=>c.attributes['$eve.model'])?.attributes['$eve.model']||'—')}</div>
        <div><span class="k">trigger</span> \${esc(a['$eve.trigger']||'—')}</div>
        <div><span class="k">events</span> \${d.eventCount}</div>
        <div><span class="k">child runs</span> \${d.childRuns.length}</div>
      </div>
    </div>
    \${turns}
    <details class="card"><summary>raw event log (\${d.eventCount})</summary>
      <pre>\${esc(d.events.map(e=>e.at+'  '+e.type).join('\\n'))}</pre></details>
    <details class="card"><summary>run attributes</summary>
      <pre>\${esc(JSON.stringify(d.session.attributes,null,2))}</pre>
      \${d.childRuns.map(c=>'<pre>'+esc(c.workflowName+'\\n'+JSON.stringify(c.attributes,null,2))+'</pre>').join('')}
    </details>\`;
}

// Poll the store's newest mtime; refresh only when something actually changed.
async function tick(){
  try{
    const p=await (await fetch('/api/pulse')).json();
    document.getElementById('live').textContent=new Date().toLocaleTimeString();
    if(p.newest!==lastPulse){ lastPulse=p.newest; await loadRuns(); if(sel) await pick(sel); }
  }catch{}
}
loadRuns(); setInterval(tick,1500);
</script>`;
