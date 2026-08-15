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
import { ReactFlow, Background, Controls } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Copy, Pencil, Trash } from "vercel-geist-icons";
import OcChat from "../components/oc-chat.jsx";

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

  // TRIGGERS on top (schedules + channels start executions), the agent in the
  // middle, CAPABILITIES below (tools + connections it can reach for).

  // -- top-right: channel icon circles feed the Channels pill
  const CHAN_W = 140;
  const chanCX = 260;
  const circleY = 0;
  const pillY = channels.length ? 92 : 40;
  channels.forEach((c, i) => {
    const x = chanCX + (i - (channels.length - 1) / 2) * 96;
    const isSlack = /slack/i.test(c.name) || /slack/i.test(c.kind);
    nodes.push({
      id: `ch:${i}`, position: { x: x - 23, y: circleY }, style: { width: 46 },
      data: {
        label: (
          <div className="circle-label" title={`${c.name} (${c.kind})`}>
            <span className="circle">{isSlack ? <SlackIcon /> : <span className="api-badge">API</span>}</span>
            <i>{c.name}</i>
          </div>
        ),
      },
      className: "gcircle", sourcePosition: "bottom",
    });
    E(`e:ch:${i}`, `ch:${i}`, "cat:channels");
  });
  nodes.push({
    id: "cat:channels", position: { x: chanCX - CHAN_W / 2, y: pillY }, style: { width: CHAN_W },
    data: { label: (<div className="pill-label">{channels.length} Channel{channels.length === 1 ? "" : "s"}</div>) },
    className: "gpill" + (channels.length ? "" : " empty"),
    sourcePosition: "bottom", targetPosition: "top",
  });
  const srcBottom = pillY + 38;
  E("e:channels-agent", "cat:channels", "agent", { dashed: !channels.length });

  // -- top-left: schedules as a Tools-style box (empty pill fallback)
  if (schedules.length) {
    const schedH = 42 + schedules.length * 44;
    nodes.push({
      id: "box:schedules", position: { x: -260 - 110, y: srcBottom - schedH }, style: { width: 220 },
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
  } else {
    nodes.push({
      id: "cat:schedules", position: { x: -260 - 66, y: srcBottom - 38 }, style: { width: 132 },
      data: { label: (<div className="pill-label">0 Schedules</div>) },
      className: "gpill empty", sourcePosition: "bottom", targetPosition: "top",
    });
    E("e:cat:schedules", "cat:schedules", "agent", { dashed: true });
  }

  // -- middle: the agent
  const yAgent = srcBottom + 90;
  const nameLen = Math.min((info.name ?? "").length, 40);
  const AGENT_W = Math.round(44 + 15 + 9 + 10 + nameLen * 8.8); // +10 slack: an under-estimate ellipsizes
  nodes.push({
    id: "agent", position: { x: -AGENT_W / 2, y: yAgent }, style: { width: AGENT_W },
    data: { label: (<div className="agent-label"><span className="agent-logo"><EveDots /></span><b>{info.name}</b></div>) },
    className: "gagent", sourcePosition: "bottom", targetPosition: "top",
  });

  // -- bottom: capabilities the agent reaches for
  const yCaps = yAgent + 110;
  nodes.push({
    id: "box:tools", position: { x: -160 - 115, y: yCaps }, style: { width: 230 },
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
    className: "gbox", targetPosition: "top",
  });
  E("e:agent-tools", "agent", "box:tools", { dashed: !tools.length });

  nodes.push({
    id: "cat:connections", position: { x: 260 - 75, y: yCaps }, style: { width: 150 },
    data: { label: (<div className="pill-label">{connections.length} Connections</div>) },
    className: "gpill" + (connections.length ? "" : " empty"), targetPosition: "top",
  });
  E("e:agent-connections", "agent", "cat:connections", { dashed: !connections.length });

  return { nodes, edges };
}

function Build() {
  const q = useSearchParams();
  const project = q.get("project") ?? "";

  const { data: info, error: infoErr, isLoading: infoLoading, mutate: refetchInfo } = useSWR(
    project ? `/api/agent-info?project=${encodeURIComponent(project)}` : null,
    fetcher,
    { refreshInterval: 3000, revalidateOnFocus: true, keepPreviousData: true },
  );

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
        {infoLoading && <div className="empty"><Spinner /> Compiling agent manifest…</div>}
        {infoErr && <div className="empty bad">{String(infoErr.message)}</div>}
        {info && (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            fitView
            proOptions={{ hideAttribution: true }}
            nodesDraggable
            nodesConnectable={false}
            colorMode="dark"
          >
            <Background color="#1f1f1f" gap={22} />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
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
