"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR, { preload } from "swr";

const ENVS = ["local", "preview", "production"];

// Same period set and labels Vercel's Agent Runs uses.
const PERIODS = [
  ["5m", "Last 5 min"], ["15m", "Last 15 min"], ["1h", "Last hour"],
  ["6h", "Last 6 hours"], ["12h", "Last 12 hours"], ["1d", "Last 24 hours"],
  ["3d", "Last 3 days"], ["7d", "Last 7 days"], ["14d", "Last 14 days"],
  ["30d", "Last 30 days"],
];
const DEFAULT_PERIOD = "12h";
const periodLabel = (v) => PERIODS.find(([k]) => k === v)?.[1] ?? v;

const fetcher = (url) => fetch(url).then((r) => r.json());

const money = (n) => "$" + (Number(n) || 0).toFixed(4);
const kt = (n) => {
  const v = Number(n) || 0;
  return v >= 1000 ? (v / 1000).toFixed(1) + "K" : String(v);
};
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
  const { data } = useSWR("/api/projects", fetcher, {
    refreshInterval: 5000,
    keepPreviousData: true,
  });

  const projects = data?.projects ?? [];
  const current = projects.find((p) => p.name === value) ?? projects.find((p) => p.live) ?? projects[0];
  const live = projects.filter((p) => p.live);
  const rest = projects.filter((p) => !p.live);

  const Row = (p) => (
    <button key={p.name + p.localPort} onClick={() => { onChange(p); setOpen(false); }}>
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

function PeriodPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="picker">
      <button onClick={() => setOpen((o) => !o)}>
        <span className="dim2">🗓</span>
        <span>{periodLabel(value)}</span>
        <span className="dim2">▾</span>
      </button>
      {open && (
        <div className="menu right" onMouseLeave={() => setOpen(false)}>
          {PERIODS.map(([k, label]) => (
            <button key={k} data-on={k === value ? "1" : "0"} onClick={() => { onChange(k); setOpen(false); }}>
              <span>{label}</span>
            </button>
          ))}
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
  const period = q.get("period") ?? DEFAULT_PERIOD;
  const project = q.get("project") ?? "";

  const setParams = (patch) => {
    const next = new URLSearchParams(q.toString());
    for (const [k, v] of Object.entries(patch)) next.set(k, v);
    router.replace("/?" + next.toString());
  };
  const setParam = (k, v) => setParams({ [k]: v });

  // A project with no local dev server has no local store to read, so switching
  // to it while on "local" would only ever show an error.
  const pickProject = (p) =>
    setParams({ project: p.name, environment: p.live ? environment : "production" });

  const isLocal = environment === "local";
  const { data, isLoading } = useSWR(
    `/api/runs?environment=${environment}&period=${period}&project=${encodeURIComponent(project)}`,
    fetcher,
    {
      // Local runs land on disk as they happen, so poll. Remote calls spawn a CLI
      // and each cold run view triggers an audit-logged decrypt, so never poll it.
      refreshInterval: isLocal ? 2000 : 0,
      revalidateOnFocus: isLocal,
      keepPreviousData: true,
    },
  );

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

  const projectName = data?.project?.name ?? project;
  const runHref = (runId) =>
    `/run/${runId}?environment=${environment}&period=${period}&project=${encodeURIComponent(projectName)}`;
  const detailKey = (runId) =>
    `/api/run/${encodeURIComponent(runId)}?environment=${environment}&project=${encodeURIComponent(projectName)}`;

  // Warm the detail before the click lands. Local reads are free, so prefetch the
  // most recent few eagerly. Remote costs a CLI spawn and an audit-logged decrypt
  // per run, so only prefetch on hover — that's the user showing intent.
  const warm = (runId) => {
    preload(detailKey(runId), fetcher);
    router.prefetch(runHref(runId));
  };

  useEffect(() => {
    if (!isLocal) return;
    for (const s of sessions.slice(0, 5)) warm(s.runId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLocal, sessions.length, environment, projectName]);

  return (
    <>
      <div className="topbar">
        <div className="crumb">
          <span>Observability</span><span>/</span><b>Agent Runs</b>
        </div>
        <ProjectPicker value={project || data?.project?.name} onChange={pickProject} />
        <div className="spacer" />
        <Seg options={ENVS} value={environment} onChange={(v) => setParam("environment", v)} />
        <PeriodPicker value={period} onChange={(v) => setParam("period", v)} />
      </div>

      <div className="wrap">
        {data?.error && (
          <div className="err">
            <b>{environment}</b> unavailable — {data.error}
          </div>
        )}
        {!isLocal && !data?.error && (
          <div className="note">
            Reading <b>{environment}</b> for <span className="mono">{data?.project?.name}</span> from the Vercel
            analytics API
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
                onMouseEnter={() => warm(s.runId)}
                onClick={() => router.push(runHref(s.runId))}
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

        {isLoading && !sessions.length && <div className="empty">Loading {environment} runs…</div>}
        {!isLoading && !sessions.length && !data?.error && (
          <div className="empty">
            No <b>{environment}</b> runs in the window “{periodLabel(period)}”.
            {isLocal && " Talk to your agent and they'll appear here."}
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
