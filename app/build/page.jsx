"use client";

// Build — the OpenCode TUI on the agent's checkout, beside a live map.
// Left: the real OpenCode terminal (attached to the cockpit's shared server,
// GLM via the AI Gateway preset). Right: React Flow graph in Vercel's layout —
// Tools box + category pills converging into the agent pill, channels below.
// Edits land on disk, so generated tools appear as graph rows moments later;
// the graph's buttons inject prompts straight into the TUI.

import { useMemo, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import dynamic from "next/dynamic";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Copy, Pencil, Trash } from "vercel-geist-icons";
import OcChat from "../components/oc-chat.jsx";
import { AsciiLoader } from "../components/ascii-loader.jsx";

// The graph canvas loads after the route paints — see components/agent-graph.
const AgentGraph = dynamic(() => import("../components/agent-graph.jsx"), {
  ssr: false,
  loading: () => <ManifestLoader label="Loading graph…" sub="Preparing the canvas" />,
});

const fetcher = async (url) => {
  const r = await fetch(url);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? "failed");
  return body;
};

const SlackIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18">
    <path fill="#E01E5A" d="M5.04 15.16a2.02 2.02 0 11-2.02-2.02h2.02zM6.06 15.16a2.02 2.02 0 114.04 0v5.06a2.02 2.02 0 11-4.04 0z"/>
    <path fill="#36C5F0" d="M8.08 5.04a2.02 2.02 0 112.02-2.02v2.02zM8.08 6.06a2.02 2.02 0 110 4.04H3.02a2.02 2.02 0 110-4.04z"/>
    <path fill="#2EB67D" d="M18.2 8.08a2.02 2.02 0 112.02 2.02H18.2zM17.18 8.08a2.02 2.02 0 11-4.04 0V3.02a2.02 2.02 0 114.04 0z"/>
    <path fill="#ECB22E" d="M15.16 18.2a2.02 2.02 0 11-2.02 2.02V18.2zM15.16 17.18a2.02 2.02 0 110-4.04h5.06a2.02 2.02 0 110 4.04z"/>
  </svg>
);
const EveDots = () => (
  <svg viewBox="0 0 16 16" width="15" height="15">
    {[[3,3],[8,2.5],[13,3],[2.5,8],[8,8],[13.5,8],[3,13],[8,13.5],[13,13]].map(([x,y],i)=>(
      <circle key={i} cx={x} cy={y} r={i%2?1.1:1.5} fill="#000"/>
    ))}
  </svg>
);

// Plain-English cron for the schedule rows ("daily 13:00 UTC", "hourly :10").
// Covers the shapes agents actually use; anything exotic shows raw.
function humanCron(cron) {
  if (!cron) return null;
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = p;
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const pad = (n) => String(n).padStart(2, "0");
  if (min.startsWith("*/") && hour === "*") return `every ${min.slice(2)} min`;
  if (min === "*" && hour === "*") return "every minute";
  if (/^\d+$/.test(min) && hour === "*") return `hourly at :${pad(min)}`;
  if (/^\d+$/.test(min) && hour.startsWith("*/")) return `every ${hour.slice(2)}h at :${pad(min)}`;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const t = `${pad(hour)}:${pad(min)} UTC`;
    if (dom === "*" && dow === "*") return `daily ${t}`;
    if (dom === "*" && /^\d+$/.test(dow)) return `${DAYS[Number(dow) % 7]} ${t}`;
    if (/^\d+$/.test(dom) && dow === "*") return `monthly on the ${dom} at ${t}`;
  }
  return cron;
}

// Vercel's agent-graph layout. Tools live inside one box node; static edges
// (no animation — they carry no traffic), dashed when a category is empty.
function toGraph(info, actions) {
  if (!info) return { nodes: [], edges: [] };
  const nodes = [];
  const edges = [];
  const E = (id, source, target, opts = {}) =>
    edges.push({ id, source, target, type: "smoothstep", pathOptions: { borderRadius: 18 }, className: "gedge" + (opts.dashed ? " dashed" : "") });

  const tools = info.tools ?? [];
  const schedules = info.schedules ?? [];
  const connections = info.connections ?? [];
  const channels = info.channels ?? [];

  const boxH = 42 + Math.max(tools.length, 1) * 34;
  const schedH = 42 + Math.max(schedules.length, 1) * 44; // two-line rows
  const srcBottom = 40 + Math.max(boxH, schedules.length ? schedH : 0); // shared baseline
  nodes.push({
    id: "box:tools", position: { x: -115, y: srcBottom - boxH }, style: { width: 230 },
    data: {
      label: (
        <div className="toolbox">
          <div className="box-title">{tools.length} Tool{tools.length === 1 ? "" : "s"}</div>
          {tools.length ? tools.map((t) => (
            <div key={t} className="box-item nodrag">
              <button className="box-name" onClick={() => actions.explain(t)} title={`Ask Build what ${t} does`}>{t}</button>
              <span className="box-actions">
                <Button variant="ghost" size="icon-sm" title="Copy name" onClick={() => navigator.clipboard?.writeText(t)}><Copy /></Button>
                <Button variant="ghost" size="icon-sm" title={`Edit agent/tools/${t}.ts`} onClick={() => actions.edit(t)}><Pencil /></Button>
                <Button variant="ghost" size="icon-sm" className="del" title={`Delete ${t}`} onClick={() => actions.remove(t)}><Trash /></Button>
              </span>
            </div>
          )) : <div className="box-item empty">none yet</div>}
        </div>
      ),
    },
    className: "gbox", sourcePosition: "bottom", targetPosition: "top",
  });
  E("e:box:tools", "box:tools", "agent", { dashed: !tools.length });

  // Schedules render like Tools — a box listing each schedule with its
  // human-readable cadence. Falls back to the empty pill when none exist.
  if (schedules.length) {
    nodes.push({
      id: "box:schedules", position: { x: -290 - 110, y: srcBottom - schedH }, style: { width: 220 },
      data: {
        label: (
          <div className="toolbox">
            <div className="box-title">{schedules.length} Schedule{schedules.length === 1 ? "" : "s"}</div>
            {schedules.map((sc) => (
              <div key={sc.name} className="box-item sched nodrag">
                <button className="box-name" onClick={() => actions.explainSchedule(sc.name)} title={`Ask Build what ${sc.name} does`}>
                  {sc.name}
                  <i className="sched-when">{humanCron(sc.cron) ?? "—"}</i>
                </button>
                <span className="box-actions">
                  <Button variant="ghost" size="icon-sm" title={`Edit agent/schedules/${sc.name}.ts`} onClick={() => actions.editSchedule(sc.name)}><Pencil /></Button>
                  <Button variant="ghost" size="icon-sm" className="del" title={`Delete ${sc.name}`} onClick={() => actions.removeSchedule(sc.name)}><Trash /></Button>
                </span>
              </div>
            ))}
          </div>
        ),
      },
      className: "gbox", sourcePosition: "bottom", targetPosition: "top",
    });
    E("e:box:schedules", "box:schedules", "agent");
  }

  // Side pills sit so their BOTTOM aligns with the box bottoms — every edge
  // leaves from the same height and the merge is symmetric.
  const cats = [
    ...(schedules.length ? [] : [{ id: "cat:schedules", label: "0 Schedules", x: -290, w: 132, empty: true }]),
    { id: "cat:connections", label: `${connections.length} Connections`, x: 290, w: 150, empty: !connections.length },
  ];
  for (const c of cats) {
    nodes.push({
      id: c.id, position: { x: c.x - c.w / 2, y: srcBottom - 38 }, style: { width: c.w },
      data: { label: (<div className="pill-label">{c.label}</div>) },
      className: "gpill" + (c.empty ? " empty" : ""),
      sourcePosition: "bottom", targetPosition: "top",
    });
    E(`e:${c.id}`, c.id, "agent", { dashed: c.empty });
  }

  const yAgent = srcBottom + 90;
  // Content-sized pill with a numeric width so the spine's centerline stays
  // exact: 22px padding each side + 15px logo + 9px gap + ~8.6px/char
  // (15px/600 Geist), capped at 40 chars (CSS ellipsizes the rest).
  const nameLen = Math.min((info.name ?? "").length, 40);
  const AGENT_W = Math.round(44 + 15 + 9 + 10 + nameLen * 8.8); // +10 slack: an under-estimate ellipsizes
  nodes.push({
    id: "agent", position: { x: -AGENT_W / 2, y: yAgent }, style: { width: AGENT_W },
    data: { label: (<div className="agent-label"><span className="agent-logo"><EveDots /></span><b>{info.name}</b></div>) },
    className: "gagent", sourcePosition: "bottom", targetPosition: "top",
  });

  const CHAN_W = 140;
  nodes.push({
    id: "cat:channels", position: { x: -CHAN_W / 2, y: yAgent + 110 }, style: { width: CHAN_W },
    data: { label: (<div className="pill-label">{channels.length} Channel{channels.length === 1 ? "" : "s"}</div>) },
    className: "gpill" + (channels.length ? "" : " empty"),
    sourcePosition: "bottom", targetPosition: "top",
  });
  E("e:agent-channels", "agent", "cat:channels", { dashed: !channels.length });

  channels.forEach((c, i) => {
    const x = (i - (channels.length - 1) / 2) * 96;
    const isSlack = /slack/i.test(c.name) || /slack/i.test(c.kind);
    nodes.push({
      id: `ch:${i}`, position: { x: x - 23, y: yAgent + 200 }, style: { width: 46 },
      data: {
        label: (
          <div className="circle-label" title={`${c.name} (${c.kind})`}>
            <span className="circle">{isSlack ? <SlackIcon /> : <span className="api-badge">API</span>}</span>
            <i>{c.name}</i>
          </div>
        ),
      },
      className: "gcircle", targetPosition: "top",
    });
    E(`e:ch:${i}`, "cat:channels", `ch:${i}`);
  });

  return { nodes, edges };
}

// Loading the manifest shows the graph's centerpiece already forming: the same
// white pill as the agent node, with a ring spinner in place of the eve mark.
// The wrapper span spins, not the SVG (rendering-animate-svg-wrapper).
function SpinnerRing() {
  const size = 22, stroke = 2.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span className="ringspin">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line2)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke="var(--dim)" strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={`${(c * 0.28).toFixed(2)} ${(c * 0.72).toFixed(2)}`}
        />
      </svg>
    </span>
  );
}

function ManifestLoader({ label = "Compiling manifest…", sub = "Reading tools, schedules and channels" }) {
  return (
    <div className="graph-load">
      <div className="manifest-pill">
        <SpinnerRing />
        <span className="manifest-text">
          <b>{label}</b>
          <i className="manifest-sub">{sub}</i>
        </span>
      </div>
    </div>
  );
}

function Build() {
  const q = useSearchParams();
  const project = q.get("project") ?? "";

  const { data: raw, error: infoErr, mutate: refetchInfo } = useSWR(
    project ? `/api/agent-info?project=${encodeURIComponent(project)}` : null,
    fetcher,
    {
      // The route answers 202 {compiling} instead of holding the connection —
      // poll quickly until the manifest lands, then fall back to the watch
      // interval that keeps the graph in sync with the files.
      refreshInterval: (latest) => (latest?.compiling ? 400 : 3000),
      revalidateOnFocus: true,
      keepPreviousData: true,
    },
  );
  const info = raw?.compiling ? null : raw;
  const infoLoading = !info && !infoErr;

  // Graph buttons hand text to the chat: explain/delete submit, edit
  // pre-fills the composer so you finish the sentence yourself.
  const oc = (text, submit = true) => window.dispatchEvent(new CustomEvent("oc:send", { detail: { text, submit } }));
  const actionsRef = useRef({});
  actionsRef.current.explain = (t) =>
    oc(`What does agent/tools/${t}.ts do? Show the important part of the code briefly.`);
  actionsRef.current.edit = (t) => oc(`Edit agent/tools/${t}.ts: `, false);
  actionsRef.current.remove = (t) =>
    oc(`Delete the tool agent/tools/${t}.ts and remove any references to it (check agent/instructions.md and update it if it mentions ${t}).`);
  actionsRef.current.explainSchedule = (n) =>
    oc(`What does the schedule agent/schedules/${n}.ts do and when does it run? Answer briefly in local time and UTC.`);
  actionsRef.current.editSchedule = (n) => oc(`Edit agent/schedules/${n}.ts: `, false);
  actionsRef.current.removeSchedule = (n) =>
    oc(`Delete the schedule agent/schedules/${n}.ts and remove any references to it.`);
  const actions = useMemo(() => ({
    explain: (t) => actionsRef.current.explain(t),
    edit: (t) => actionsRef.current.edit(t),
    remove: (t) => actionsRef.current.remove(t),
    explainSchedule: (n) => actionsRef.current.explainSchedule(n),
    editSchedule: (n) => actionsRef.current.editSchedule(n),
    removeSchedule: (n) => actionsRef.current.removeSchedule(n),
  }), []);

  const { nodes, edges } = useMemo(() => toGraph(info, actions), [info, actions]);

  if (!project) return <div className="empty">Pick a project first — Build works on a local checkout.</div>;

  return (
    <div className="buildpage">
      <div className="buildcol chatmode">
        <OcChat
          project={project}
          onIdle={() => fetch(`/api/agent-info?project=${encodeURIComponent(project)}&fresh=1`).then(() => refetchInfo())}
        />
      </div>

      <div className="buildflow">
        {infoLoading && <ManifestLoader />}
        {infoErr && <div className="empty bad">{String(infoErr.message)}</div>}
        {info?.eveVersion && (
          <span className="eve-ver mono" title="Installed eve framework version">eve v{info.eveVersion}</span>
        )}
        {info && <AgentGraph nodes={nodes} edges={edges} />}
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="empty">Loading…</div>}>
      <Build />
    </Suspense>
  );
}
