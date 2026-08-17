"use client";

import { useState, useEffect, useMemo, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR, { preload } from "swr";
import { I, triggerIcon } from "@/app/components/icons.jsx";
import { ChevronLeft, ChevronRight, FolderPlus } from "vercel-geist-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dropdown, DropdownItem, DropdownCheckItem } from "@/app/components/dropdown.jsx";

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
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  return v >= 1000 ? (v / 1000).toFixed(1).replace(/\.0$/, "") + "K" : String(v);
};
const dur = (ms) => {
  if (ms == null) return "—";
  if (ms < 1000) return ms + "ms";
  const s = ms / 1000;
  return (s < 10 ? s.toFixed(2).replace(/\.?0+$/, "") : Math.round(s)) + "s";
};
const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return Math.floor(s) + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
};
const statusClass = (s) => (s === "completed" ? "ok" : s === "failed" ? "bad" : "warn");
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
// "channel:photon" reads as just "photon" — the icon already says channel.
const trigLabel = (t) => (t?.startsWith("channel:") ? t.slice(8) : cap(t));
// Chip labels: abbreviate only where unambiguous — "prev" reads as "previous".
const envShort = (e) => (e === "production" ? "prod" : e);

function PeriodPicker({ value, onChange }) {
  return (
    <Dropdown align="end" label={<><span className="dim2">{I.calendar}</span>{periodLabel(value)}</>}>
      {(close) => PERIODS.map(([k, label]) => (
        <DropdownItem key={k} on={k === value} onSelect={() => { onChange(k); close(); }}>{label}</DropdownItem>
      ))}
    </Dropdown>
  );
}

const ENV_DEFAULT = "local,preview,production";
// v2: the v1 key could hold a URL-derived value, which is no longer a
// preference — a fresh key resets everyone to "all environments" once.
const ENV_KEY = "eve-cockpit:env2";

// Multi-select environments, Vercel-style: checkboxes + Select All. Value is a
// comma list in the URL ("local,production").
function EnvPicker({ value, onChange, hasLocal = true }) {
  const selected = value.split(",").map((e) => e.trim()).filter(Boolean);
  const all = selected.length === ENVS.length;
  // "All Environments" when everything is on; otherwise the explicit list
  // ("Local + Preview") so you always see exactly what's selected.
  const label = all ? "All Environments" : selected.map(cap).join(" + ") || "Local";

  const toggle = (env) => {
    if (env === "local" && !hasLocal) return;
    const next = selected.includes(env) ? selected.filter((e) => e !== env) : [...selected, env];
    if (next.length === 0) return; // at least one stays selected
    onChange(ENVS.filter((e) => next.includes(e)).join(","));
  };

  return (
    <Dropdown label={label}>
      <DropdownItem onSelect={() => onChange(all ? "local" : ENVS.join(","))}>
        {all ? "Deselect All" : "Select All"}
      </DropdownItem>
      {/* An agent with no folder on this Mac can never have local runs, so the
          filter says so rather than offering a view that is always empty. */}
      {ENVS.map((o) => (
        <DropdownCheckItem
          key={o}
          checked={selected.includes(o)}
          onToggle={() => toggle(o)}
          disabled={o === "local" && !hasLocal}
          title={o === "local" && !hasLocal ? "No folder for this agent on this Mac" : undefined}
        >
          {cap(o)}
        </DropdownCheckItem>
      ))}
    </Dropdown>
  );
}

// ---- charts ---------------------------------------------------------------

function buckets(sessions, n = 48) {
  const out = Array.from({ length: n }, () => ({ runs: 0, input: 0, output: 0, cached: 0 }));
  if (!sessions.length) return out;
  const times = sessions.map((s) => new Date(s.createdAt).getTime());
  const min = Math.min(...times), max = Math.max(...times);
  const span = Math.max(max - min, 1);
  for (const s of sessions) {
    const i = Math.min(n - 1, Math.floor(((new Date(s.createdAt) - min) / span) * n));
    out[i].runs += 1;
    out[i].input += s.inputTokens;
    out[i].output += s.outputTokens;
    out[i].cached += s.cacheReadTokens;
  }
  return out;
}

// Vercel's Runs chart: sharp spikes per bucket on a baseline.
function SpikeChart({ data }) {
  const W = 600, H = 120, max = Math.max(...data.map((d) => d.runs), 1);
  const step = W / data.length;
  let path = `M0 ${H - 1}`;
  data.forEach((d, i) => {
    const x = i * step + step / 2;
    if (d.runs > 0) {
      const y = H - 4 - ((d.runs / max) * (H - 14));
      path += ` L${x - 1.5} ${H - 1} L${x} ${y} L${x + 1.5} ${H - 1}`;
    }
  });
  path += ` L${W} ${H - 1}`;
  return (
    <div className="chartwrap">
      <div className="yaxis"><span>{max}</span><span>{max > 1 ? Math.round(max / 2) : "0.5"}</span><span>0</span></div>
      <svg className="chartsvg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <line x1="0" y1={H - 1} x2={W} y2={H - 1} stroke="var(--line)" />
        <path d={path} stroke="var(--purple)" strokeWidth="1.5" fill="none" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

// Vercel's Tokens chart: thin stacked bars — input blue, output purple, cached gray.
function StackedBars({ data }) {
  const W = 600, H = 120;
  const max = Math.max(...data.map((d) => d.input + d.output + d.cached), 1);
  const step = W / data.length;
  return (
    <svg className="chartsvg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <line x1="0" y1={H - 1} x2={W} y2={H - 1} stroke="var(--line)" />
      {data.map((d, i) => {
        const total = d.input + d.output + d.cached;
        if (!total) return null;
        const x = i * step + step / 2 - 2;
        const h = (total / max) * (H - 14);
        const hc = (d.cached / total) * h, ho = (d.output / total) * h, hi = h - hc - ho;
        let y = H - 2;
        const segs = [];
        for (const [hh, color] of [[hc, "var(--chart-cached)"], [hi, "var(--blue)"], [ho, "var(--purple)"]]) {
          if (hh > 0.5) { segs.push(<rect key={color} x={x} y={y - hh} width="4" height={hh} fill={color} rx="1" />); }
          y -= hh;
        }
        return <g key={i}>{segs}</g>;
      })}
    </svg>
  );
}

// ---- dashboard ------------------------------------------------------------

function Dashboard() {
  const router = useRouter();
  const q = useSearchParams();
  const environment = q.get("environment") ?? ENV_DEFAULT;
  const period = q.get("period") ?? DEFAULT_PERIOD;
  const project = q.get("project") ?? "";

  const [search, setSearch] = useState("");
  const [trigger, setTrigger] = useState("all");
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(0);
  const scrollRef = useRef(null);
  const updateScrollEdges = () => {
    const el = scrollRef.current;
    if (!el) return;
    const more = el.scrollWidth - el.clientWidth;
    const at = el.scrollLeft;
    el.dataset.scroll = more <= 1 ? "none" : at <= 1 ? "start" : at >= more - 1 ? "end" : "middle";
  };
  useEffect(() => {
    updateScrollEdges();
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(updateScrollEdges);
    ro.observe(el);
    return () => ro.disconnect();
  });
  useEffect(() => {
    const saved = Number(sessionStorage.getItem("runsPageSize"));
    if ([10, 20, 30, 40, 50].includes(saved)) setPageSize(saved);
  }, []);

  const setParams = (patch) => {
    const next = new URLSearchParams(q.toString());
    for (const [k, v] of Object.entries(patch)) next.set(k, v);
    router.replace("/runs?" + next.toString(), { scroll: false });
  };
  const setParam = (k, v) => setParams({ [k]: v });

  // Environment is one global app setting — same across projects, tabs and
  // restarts — and it starts with every environment selected. Only the picker
  // writes it: a URL that carries ?environment= is a link (our own nav copies
  // the current value into every href), not a preference, so persisting those
  // let one visit to a filtered link silently become the global default.
  useEffect(() => {
    if (q.get("environment")) return;
    const saved = localStorage.getItem(ENV_KEY);
    if (saved && saved !== ENV_DEFAULT) setParam("environment", saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.get("environment")]);

  const pickEnv = (v) => {
    localStorage.setItem(ENV_KEY, v);
    setParam("environment", v);
  };

  const isLocal = environment.split(",").includes("local");
  // Whether THIS agent has a folder on this Mac. The switcher already polls
  // this list, so SWR serves it from cache rather than issuing a second call.
  const { data: projectList, mutate: refetchProjects } = useSWR("/api/projects", fetcher);
  const [locating, setLocating] = useState(false);
  const chooseFolder = async () => {
    setLocating(true);
    try {
      const r = await fetch("/api/dev", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, action: "locate" }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "failed");
      if (body.cancelled) return;
      await refetchProjects();
    } catch (e) {
      alert(e.message);
    } finally {
      setLocating(false);
    }
  };
  const hasLocal = Boolean(
    (projectList?.projects ?? []).find((p) => p.name === project)?.localPath,
  );
  const { data, isLoading } = useSWR(
    `/api/runs?environment=${environment}&period=${period}&project=${encodeURIComponent(project)}`,
    fetcher,
    { refreshInterval: isLocal ? 2000 : 0, revalidateOnFocus: isLocal, keepPreviousData: true },
  );

  const all = data?.sessions ?? [];
  const triggers = useMemo(() => [...new Set(all.map((s) => s.trigger))], [all]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setPage(0); }, [project, environment, period, trigger]);
  const sessions = all.filter(
    (s) =>
      (trigger === "all" || s.trigger === trigger) &&
      (!search || s.title.toLowerCase().includes(search.toLowerCase())),
  );

  const totals = sessions.reduce(
    (a, s) => ({ input: a.input + s.inputTokens, output: a.output + s.outputTokens, cached: a.cached + s.cacheReadTokens }),
    { input: 0, output: 0, cached: 0 },
  );
  const b = useMemo(() => buckets(sessions), [sessions]);

  const projectName = data?.project?.name ?? project;
  const multiEnv = environment.includes(",");
  // Each session knows which environment it came from — links must use THAT,
  // not the (possibly multi) filter value.
  const runHref = (s) =>
    `/run/${s.runId}?environment=${s.environment ?? environment}&period=${period}&project=${encodeURIComponent(projectName)}`;
  const detailKey = (s) =>
    `/api/run/${encodeURIComponent(s.runId)}?environment=${s.environment ?? environment}&project=${encodeURIComponent(projectName)}`;
  const warm = (s) => {
    preload(detailKey(s), fetcher);
    router.prefetch(runHref(s));
  };
  useEffect(() => {
    if (!isLocal) return;
    for (const s of sessions.slice(0, 5)) if ((s.environment ?? "local") === "local") warm(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLocal, sessions.length, environment, projectName]);

  const oldest = sessions.length ? ago(sessions[sessions.length - 1].createdAt) : null;
  const newest = sessions.length ? ago(sessions[0].createdAt) : null;

  return (
    <>
      <div className="wrap">
        <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
          <EnvPicker value={environment} onChange={pickEnv} hasLocal={hasLocal} />
          <div className="spacer" />
          <PeriodPicker value={period} onChange={(v) => setParam("period", v)} />
        </div>

        {/* A missing local folder is a state, not a failure: nothing is broken,
            the agent simply isn't on this Mac yet. It gets an informative note
            with the action that resolves it. Anything else keeps the red. */}
        {data?.error && (
          /no checkout/i.test(data.error) && !hasLocal ? (
            <div className="note note-action">
              <span className="note-ic"><FolderPlus /></span>
              <span>
                <b>{project}</b> isn&rsquo;t on this Mac yet. Choose its folder to see
                local runs.
              </span>
              <button className="btn-primary note-btn" onClick={chooseFolder} disabled={locating}>
                {locating ? "Opening…" : "Choose folder"}
              </button>
            </div>
          ) : (
            <div className="err"><b>{environment}</b> unavailable — {data.error}</div>
          )
        )}

        {/* Charts skeleton ONLY before the very first data. On later loads they
            hold their last render — redrawing them mid-fetch reads as a flash. */}
        {isLoading && !data ? (
          <div className="charts">
            <div className="sk card" /><div className="sk card" />
          </div>
        ) : (
          <div className="charts">
            <div className="chartcard">
              <div className="chead">
                <span className="ctitle">Runs</span>
                <span className="legend">
                  {triggers.map((t, i) => (
                    <span key={t}><i style={{ background: i === 0 ? "var(--purple)" : "var(--blue)" }} />
                      {trigLabel(t)} <b>{sessions.filter((s) => s.trigger === t).length}</b>
                    </span>
                  ))}
                </span>
              </div>
              <SpikeChart data={b} />
              <div className="axis"><span>{oldest ?? ""}</span><span>{newest ?? ""}</span></div>
            </div>
            <div className="chartcard">
              <div className="chead">
                <span className="ctitle">Tokens</span>
                <span className="legend">
                  <span><i style={{ background: "var(--blue)" }} />Input <b>{kt(totals.input)}</b></span>
                  <span><i style={{ background: "var(--purple)" }} />Output <b>{kt(totals.output)}</b></span>
                  <span><i style={{ background: "var(--chart-cached)" }} />Cached <b>{kt(totals.cached)}</b></span>
                </span>
              </div>
              <StackedBars data={b} />
              <div className="axis"><span>{oldest ?? ""}</span><span>{newest ?? ""}</span></div>
            </div>
          </div>
        )}

        <div className="filters">
          <div className="search">
            {I.search}
            <Input
              placeholder="Search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="search-input"
            />
          </div>
          <Dropdown align="end" label={trigger === "all" ? "All Triggers" : trigLabel(trigger)}>
            {(close) => (
              <>
                <DropdownItem on={trigger === "all"} onSelect={() => { setTrigger("all"); close(); }}>All Triggers</DropdownItem>
                {triggers.map((t) => (
                  <DropdownItem key={t} on={trigger === t} onSelect={() => { setTrigger(t); close(); }}>{trigLabel(t)}</DropdownItem>
                ))}
              </>
            )}
          </Dropdown>
        </div>

        <div className="tablecard">
          {/* Only the table scrolls sideways — the footer must not ride along.
              data-scroll drives the edge fades so they appear only on the side
              that actually has more content. */}
          <div className="tablescroll" ref={scrollRef} onScroll={updateScrollEdges}>
          <table>
            {/* Fixed layout: Run always takes the remaining space regardless of
                content length; numeric columns never drift. */}
{/* No fixed widths: like Vercel, data columns size to their content
                (max-content) and the Run column absorbs whatever is left. */}
            <thead>
              <tr>
                <th>Run</th><th>Trigger</th><th className="num">Cost</th>
                <th className="num">Tokens In</th><th className="num">Tokens Out</th>
                <th className="num">Turns</th><th className="num">Created</th><th className="num">Updated</th><th />
              </tr>
            </thead>
            <tbody>
              {isLoading && Array.from({ length: Math.min(pageSize, 8) }).map((_, i) => (
                <tr key={`sk-${i}`} className="skrow">
                  <td colSpan={9}><div className="sk row" style={{ opacity: 1 - i * 0.1 }} /></td>
                </tr>
              ))}
              {!isLoading && sessions.slice(page * pageSize, (page + 1) * pageSize).map((s) => (
                <tr key={s.runId} onMouseEnter={() => warm(s)} onClick={() => router.push(runHref(s))}>
                  <td className="title-cell">
                    {multiEnv && <span className={"envchip" + (s.environment === "local" ? " loc" : s.environment === "production" ? " prod" : "")}>{envShort(s.environment)}</span>}
                    {s.title}
                  </td>
                  <td><span className="trigger-badge">{triggerIcon(s.trigger)} {trigLabel(s.trigger)}</span></td>
                  <td className="num">{money(s.costUsd)}</td>
                  <td className="num">{kt(s.inputTokens)}</td>
                  <td className="num">{kt(s.outputTokens)}</td>
                  <td className="num">{s.turns}{s.subagents ? ` +${s.subagents}` : ""}</td>
                  <td className="num">{ago(s.createdAt)}</td>
                  <td className="num">{ago(s.createdAt)}</td>
                  <td className="rowchev"><span>{I.chevRight}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          {sessions.length > 0 && (
            <div className="tfoot">
              {/* The last shadcn Select in the app — it kept its own panel,
                  rows and check while every other menu moved to the shared
                  one. */}
              <Dropdown align="start" className="tfoot-size" label={`Show ${pageSize}`}>
                {(close) => [10, 20, 30, 40, 50].map((n) => (
                  <DropdownItem
                    key={n}
                    on={n === pageSize}
                    onSelect={() => {
                      setPageSize(n); setPage(0);
                      sessionStorage.setItem("runsPageSize", String(n));
                      close();
                    }}
                  >Show {n}</DropdownItem>
                ))}
              </Dropdown>
              <div className="spacer" />
              <span className="tfoot-page">{page + 1} of {Math.max(1, Math.ceil(sessions.length / pageSize))}</span>
              <Button variant="outline" size="icon-sm" disabled={page === 0}
                onClick={() => setPage((p) => p - 1)} title="Previous page"><ChevronLeft /></Button>
              <Button variant="outline" size="icon-sm" disabled={(page + 1) * pageSize >= sessions.length}
                onClick={() => setPage((p) => p + 1)} title="Next page"><ChevronRight /></Button>
            </div>
          )}
          {!isLoading && !sessions.length && !data?.error && (
            <div className="empty">
              No <b>{environment}</b> runs in the window “{periodLabel(period)}”.
              {isLocal && " Talk to your agent and they'll appear here."}
            </div>
          )}
        </div>
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
