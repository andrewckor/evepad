"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

const ENVS = ["local", "preview", "production"];
const PERIODS = ["1h", "6h", "1d", "7d", "30d", "all"];

const money = (n) => "$" + (n || 0).toFixed(4);
const kt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n || 0));
const dur = (ms) => (ms == null ? "—" : ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s");
const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return Math.floor(s) + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
};
const statusClass = (s) => (s === "completed" ? "ok" : s === "failed" ? "bad" : "warn");

// Green dot = an `eve dev` server is listening locally for this project, matched
// through its .vercel/project.json rather than by name.
export function ProjectPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState([]);

  useEffect(() => {
    const load = async () => {
      const r = await fetch("/api/projects");
      const d = await r.json();
      setProjects(d.projects ?? []);
    };
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const current = projects.find((p) => p.name === value) ?? projects.find((p) => p.live) ?? projects[0];
  const live = projects.filter((p) => p.live);
  const rest = projects.filter((p) => !p.live);

  const Row = (p) => (
    <button key={p.name + p.localPort} onClick={() => { onChange(p.name); setOpen(false); }}>
      <span className={"dot" + (p.live ? " on" : "")} />
      <span>{p.name}</span>
      <span className="sub">{p.live ? `:${p.localPort}` : p.source === "vercel" ? "remote" : ""}</span>
    </button>
  );

  return (
    <div className="picker">
      <button onClick={() => setOpen((o) => !o)}>
        <span className={"dot" + (current?.live ? " on" : "")} />
        <span>{current?.name ?? "select project"}</span>
        <span className="dim2">▾</span>
      </button>
      {open && (
        <div className="menu" onMouseLeave={() => setOpen(false)}>
          {live.length > 0 && <div className="hd">running locally</div>}
          {live.map(Row)}
          {rest.length > 0 && <div className="hd">vercel projects</div>}
          {rest.map(Row)}
          {!projects.length && <div className="hd">no projects found</div>}
        </div>
      )}
    </div>
  );
}

function Seg({ options, value, onChange }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o} data-on={o === value ? "1" : "0"} onClick={() => onChange(o)}>
          {o}
        </button>
      ))}
    </div>
  );
}

// Bucket sessions into a small histogram for the overview strip.
function histogram(sessions, buckets = 24) {
  if (!sessions.length) return { runs: [], tokens: [] };
  const times = sessions.map((s) => new Date(s.createdAt).getTime());
  const min = Math.min(...times), max = Math.max(...times);
  const span = Math.max(max - min, 1);
  const runs = Array(buckets).fill(0);
  const tokens = Array(buckets).fill(0);
  for (const s of sessions) {
    const i = Math.min(buckets - 1, Math.floor(((new Date(s.createdAt) - min) / span) * buckets));
    runs[i] += 1;
    tokens[i] += s.inputTokens + s.outputTokens;
  }
  return { runs, tokens };
}

function Chart({ values, alt }) {
  const max = Math.max(...values, 1);
  return (
    <div className="chart">
      {values.map((v, i) => (
        <i key={i} className={alt ? "alt" : ""} style={{ height: `${(v / max) * 100}%` }} />
      ))}
    </div>
  );
}

function Dashboard() {
  const router = useRouter();
  const q = useSearchParams();
  const environment = q.get("environment") ?? "local";
  const period = q.get("period") ?? "7d";
  const project = q.get("project") ?? "";

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const setParam = (k, v) => {
    const next = new URLSearchParams(q.toString());
    next.set(k, v);
    router.replace("/?" + next.toString());
  };

  const load = useCallback(async () => {
    const r = await fetch(
      `/api/runs?environment=${environment}&period=${period}&project=${encodeURIComponent(project)}`,
    );
    setData(await r.json());
    setLoading(false);
  }, [environment, period, project]);

  useEffect(() => {
    setLoading(true);
    load();
    // Local runs land on disk as they happen, so poll; remote is a paid API call.
    if (environment !== "local") return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [load, environment]);

  const sessions = data?.sessions ?? [];
  const totals = sessions.reduce(
    (a, s) => ({
      cost: a.cost + s.costUsd,
      input: a.input + s.inputTokens,
      output: a.output + s.outputTokens,
      cached: a.cached + s.cacheReadTokens,
      turns: a.turns + s.turns,
    }),
    { cost: 0, input: 0, output: 0, cached: 0, turns: 0 },
  );
  const h = histogram(sessions);

  return (
    <>
      <div className="topbar">
        <div className="crumb">
          <span>Observability</span><span>/</span><b>Agent Runs</b>
        </div>
        <ProjectPicker value={project || data?.project?.name} onChange={(v) => setParam("project", v)} />
        <div className="spacer" />
        <Seg options={ENVS} value={environment} onChange={(v) => setParam("environment", v)} />
        <Seg options={PERIODS} value={period} onChange={(v) => setParam("period", v)} />
      </div>

      <div className="wrap">
        {data?.error && (
          <div className="err">
            <b>{environment}</b> unavailable — {data.error}
          </div>
        )}
        {environment !== "local" && !data?.error && (
          <div className="note">
            Reading <b>{environment}</b> for <span className="mono">{data?.project?.name}</span> through{" "}
            <span className="mono">workflow inspect -b vercel</span>
            {data?.project?.localPath ? <> · local checkout at <span className="mono">{data.project.localPath}</span></> : <> · no local checkout</>}.
          </div>
        )}

        <div className="cards">
          <div className="card">
            <div className="label">Runs</div>
            <div className="value">{sessions.length}</div>
            <Chart values={h.runs} />
          </div>
          <div className="card">
            <div className="label">Tokens</div>
            <div className="value">{kt(totals.input + totals.output)}</div>
            <Chart values={h.tokens} alt />
          </div>
          <div className="card">
            <div className="label">Cost</div>
            <div className="value">{money(totals.cost)}</div>
          </div>
          <div className="card">
            <div className="label">Turns</div>
            <div className="value">{totals.turns}</div>
          </div>
          <div className="card">
            <div className="label">Cache read</div>
            <div className="value">{kt(totals.cached)}</div>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Message</th><th>Trigger</th><th>Status</th><th>Turns</th>
              <th>Tokens in / out</th><th>Cost</th><th>Duration</th><th>Time</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr
                key={s.runId}
                onClick={() =>
                  router.push(
                    `/run/${s.runId}?environment=${environment}&period=${period}&project=${encodeURIComponent(data?.project?.name ?? "")}`,
                  )
                }
              >
                <td className="title-cell">{s.title}</td>
                <td><span className="badge">{s.trigger}</span></td>
                <td className={statusClass(s.status)}>{s.status}</td>
                <td className="tnum">{s.turns}{s.subagents ? ` +${s.subagents}` : ""}</td>
                <td className="tnum">{kt(s.inputTokens)} / {kt(s.outputTokens)}</td>
                <td className="tnum">{money(s.costUsd)}</td>
                <td className="tnum">{dur(s.durationMs)}</td>
                <td className="tnum">{ago(s.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {!loading && !sessions.length && !data?.error && (
          <div className="empty">
            No runs for <b>{environment}</b> in the last {period}.
            {environment === "local" && " Talk to your agent and they'll appear here."}
          </div>
        )}
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="empty">Loading…</div>}>
      <Dashboard />
    </Suspense>
  );
}
