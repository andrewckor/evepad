"use client";

import { useState, useEffect, useMemo, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR, { preload } from "swr";
import { I, triggerIcon } from "@/app/components/icons.jsx";
import { ChevronLeft, ChevronRight, FolderPlus } from "vercel-geist-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EnvBadge } from "../components/badge.jsx";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { Dropdown, DropdownItem, DropdownCheckItem } from "@/app/components/dropdown.jsx";
import { toast } from "@/components/ui/toast";
import ReconnectDialog from "@/app/components/reconnect-dialog.jsx";

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
// The live credential toast, so every SWR poll updates it in place instead of
// stacking another copy. Base UI mints ids on add(), so we hold onto it rather
// than choosing one up front.
let authToastId = null;
// Per kind, because one message can't be both friendly and true here: an
// expired token IS expired, but a bare 403 might just be a scope this token
// can't see. Nothing blames the user, and each one says what happens next.
// `env` is null when the failure is account-wide rather than one environment
// (the project listing itself failed), so every line has to read both ways.
const scope = (env) => (env ? `your ${env} “Agent runs”` : `your “Agent runs”`);
const AUTH_COPY = {
  expired: {
    title: "Your Vercel sign-in expired",
    desc: (env) => `Sign back in to get access to ${scope(env)}.`,
  },
  missing: {
    title: "You’re not signed in to Vercel",
    desc: (env) => `Sign in to get access to ${scope(env)}.`,
  },
  forbidden: {
    // Same line as `expired`. A bare 403 can technically also be a scope this
    // account can't see, but naming that in the toast ("Vercel turned down the
    // request") reads like a wall — and the remedy is identical either way.
    // The nuance stays in the dialog, where there's room to explain it.
    title: "Your Vercel sign-in expired",
    desc: (env) => `Sign back in to get access to ${scope(env)}.`,
  },
  plan: {
    title: "Not on your plan",
    desc: (env) => `Run history this far back needs an Observability plan.`,
  },
};

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
  const out = Array.from({ length: n }, () => ({ runs: 0, input: 0, output: 0, cached: 0, cost: 0 }));
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
    out[i].cost += s.costUsd ?? 0;
  }
  return out;
}

// A stat card: the number is the headline, the chart is the shape of it.
// Sized to sit three-up rather than two big panels.
function Sparkline({ data, pick, color, fill = false }) {
  const W = 120, H = 34, vals = data.map(pick);
  const max = Math.max(...vals, 1);
  const step = W / Math.max(vals.length - 1, 1);
  const pts = vals.map((v, i) => `${i * step},${H - 2 - (v / max) * (H - 6)}`);
  return (
    <svg className="sparksvg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      {fill && <polygon points={`0,${H} ${pts.join(" ")} ${W},${H}`} fill={color} opacity=".18" />}
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.5"
        vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

function StatCard({ title, value, sub, breakdown, children }) {
  const card = (
    <div className="statcard">
      <div className="stat-text">
        <span className="stat-title">{title}</span>
        <span className="stat-value">{value}</span>
        {sub && <span className="stat-sub">{sub}</span>}
      </div>
      <div className="stat-chart">{children}</div>
    </div>
  );
  if (!breakdown?.length) return card;
  // The one hoverable tooltip in the app: it's a data readout you may want to
  // move onto, not a label.
  return (
    <Tooltip disableHoverablePopup={false}>
      <TooltipTrigger render={card} />
      <TooltipContent side="bottom" className="stat-pop">
        {/* The legend these cards replaced — same dots, same figures, now
            only when you ask for it. */}
        <span className="legend legend-col">
          {breakdown.map((r) => (
            <span key={r.label}>
              <i style={{ background: r.color ?? "var(--dim2)" }} />
              {r.label} <b>{r.value}</b>
            </span>
          ))}
        </span>
      </TooltipContent>
    </Tooltip>
  );
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
  const { data, isLoading, mutate: refetchRuns } = useSWR(
    `/api/runs?environment=${environment}&period=${period}&project=${encodeURIComponent(project)}`,
    fetcher,
    { refreshInterval: isLocal ? 2000 : 0, revalidateOnFocus: isLocal, keepPreviousData: true },
  );

  // Credentials going stale is the one failure here the user can fix, so it
  // gets the corner rather than only the empty table — including when another
  // environment still returns data and the page looks fine.
  const [reconnect, setReconnect] = useState(null);
  // ?authfail=expired|missing|forbidden|plan — the same dev-override shape as
  // ?firstrun on the home page, including the production guard: reaching this
  // state for real needs an expired token, which you can't summon on demand,
  // but a query param that fakes a credential failure has no business being
  // reachable in a build.
  const forcedAuth = process.env.NODE_ENV !== "production" ? q.get("authfail") : null;
  const auth = forcedAuth
    ? { env: "production", kind: forcedAuth, canReconnect: forcedAuth !== "plan", message: `forced: ${forcedAuth}` }
    : data?.auth ?? null;
  // The raw red banner is the only presentation that already says "no runs and
  // here's why"; the missing-checkout note does not, so the table still needs
  // its own line in that case.
  const errShown = Boolean(data?.error) && !(/no checkout/i.test(data?.error ?? "") && !hasLocal) && !auth;
  useEffect(() => {
    if (!auth) {
      if (authToastId) { toast.close(authToastId); authToastId = null; }
      return;
    }
    const copy = AUTH_COPY[auth.kind] ?? AUTH_COPY.forbidden;
    const opts = {
      title: copy.title,
      description: copy.desc(auth.env),
      // The user has to act on this one, and a toast that fades before they
      // reach it is worse than none. 0 means it never times out.
      timeout: 0,
      // A plan limit still gets a toast — it's the only surface now that the
      // inline banner is gone — but no button, because signing in again can't
      // buy a plan and a dead-end action is worse than none.
      actionProps: auth.canReconnect
        ? { children: "Reconnect", onClick: () => setReconnect(auth.kind) }
        : undefined,
    };
    if (authToastId) toast.update(authToastId, opts);
    else authToastId = toast.add(opts);
  }, [auth?.kind, auth?.env, auth?.canReconnect]);

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
    (a, s) => ({
      input: a.input + s.inputTokens,
      output: a.output + s.outputTokens,
      cached: a.cached + s.cacheReadTokens,
      cost: a.cost + (s.costUsd ?? 0),
    }),
    { input: 0, output: 0, cached: 0, cost: 0 },
  );
  const b = useMemo(() => buckets(sessions), [sessions]);
  const costByEnv = useMemo(() => {
    const by = new Map();
    for (const s of sessions) by.set(s.environment, (by.get(s.environment) ?? 0) + (s.costUsd ?? 0));
    return [...by].map(([env, v]) => ({ label: env, value: money(v), color: "var(--ok)" }));
  }, [sessions]);

  const projectName = data?.project?.name ?? project;
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
      <ReconnectDialog
        open={Boolean(reconnect)}
        onOpenChange={(v) => !v && setReconnect(null)}
        kind={reconnect ?? "forbidden"}
        onReconnected={() => {
          // The token is live again, but the runs response in SWR's cache is
          // the failed one — refetch, and drop the toast that prompted this.
          if (authToastId) { toast.close(authToastId); authToastId = null; }
          setReconnect(null);
          // Same rule as ?firstrun: the dev override must not outlive the fix
          // and strand you re-reading a failure that isn't happening any more.
          // Dropped, not set — setParam() would write the string "null".
          if (forcedAuth) {
            const next = new URLSearchParams(q.toString());
            next.delete("authfail");
            router.replace("/runs?" + next.toString(), { scroll: false });
          }
          refetchRuns();
          refetchProjects();
        }}
      />
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
          ) : auth ? null : (
            // Nothing inline for a credential failure — the toast owns it, and
            // two messages for one problem is one too many. Explicitly null
            // rather than deleted: falling through to .err below would dump the
            // raw request URL and x-vercel-id at the user.
            <div className="err"><b>{environment}</b> unavailable — {data.error}</div>
          )
        )}

        {/* Charts skeleton ONLY before the very first data. On later loads they
            hold their last render — redrawing them mid-fetch reads as a flash. */}
        {isLoading && !data ? (
          <div className="charts">
            <div className="sk statcard" /><div className="sk statcard" /><div className="sk statcard" />
          </div>
        ) : (
          <div className="charts">
            <TooltipProvider delay={150}>
            <StatCard
              title="Runs"
              value={sessions.length}
              breakdown={triggers.map((t, i) => ({
                label: trigLabel(t),
                value: sessions.filter((s) => s.trigger === t).length,
                color: i === 0 ? "var(--purple)" : "var(--blue)",
              }))}
            >
              <Sparkline data={b} pick={(d) => d.runs} color="var(--purple)" fill />
            </StatCard>
            <StatCard
              title="Tokens"
              value={kt(totals.input + totals.output)}
              sub={`${kt(totals.cached)} cached`}
              breakdown={[
                { label: "Input", value: kt(totals.input), color: "var(--blue)" },
                { label: "Output", value: kt(totals.output), color: "var(--purple)" },
                { label: "Cached", value: kt(totals.cached), color: "var(--chart-cached)" },
              ]}
            >
              <Sparkline data={b} pick={(d) => d.input + d.output} color="var(--blue)" fill />
            </StatCard>
            <StatCard
              title="Cost"
              value={money(totals.cost)}
              breakdown={costByEnv}
            >
              <Sparkline data={b} pick={(d) => d.cost} color="var(--ok)" fill />
            </StatCard>
            </TooltipProvider>
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
                    <EnvBadge env={s.environment} className="envchip" />
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
          {/* Suppressed only when the red banner is already explaining it —
              a friendly note above still leaves the table needing a word. */}
          {!isLoading && !sessions.length && !errShown && (
            <div className="empty">
              No runs in the “{periodLabel(period)}”.
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
