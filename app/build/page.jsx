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
import OpencodeTerm, { sendToOpencode } from "../components/opencode-term.jsx";

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
  const srcBottom = 40 + boxH; // one shared baseline for every top source
  nodes.push({
    id: "box:tools", position: { x: -115, y: 40 }, style: { width: 230 },
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

  // Side pills sit so their BOTTOM aligns with the Tools box bottom — every
  // edge then leaves from the same height and the merge is symmetric, not
  // a staircase around the box.
  const cats = [
    { id: "cat:schedules", label: `${schedules.length} Schedule${schedules.length === 1 ? "" : "s"}`, x: -290, w: 132, empty: !schedules.length },
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
  const AGENT_W = 180;
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

function Build() {
  const q = useSearchParams();
  const project = q.get("project") ?? "";

  const { data: info, error: infoErr, isLoading: infoLoading } = useSWR(
    project ? `/api/agent-info?project=${encodeURIComponent(project)}` : null,
    fetcher,
    { refreshInterval: 3000, revalidateOnFocus: true, keepPreviousData: true },
  );

  // Graph buttons type into the TUI's pty: explain/delete submit, edit
  // pre-fills the prompt so you finish the sentence yourself.
  const actionsRef = useRef({});
  actionsRef.current.explain = (t) =>
    sendToOpencode(project, `What does agent/tools/${t}.ts do? Show the important part of the code briefly.`);
  actionsRef.current.edit = (t) =>
    sendToOpencode(project, `Edit agent/tools/${t}.ts: `, { submit: false });
  actionsRef.current.remove = (t) =>
    sendToOpencode(project, `Delete the tool agent/tools/${t}.ts and remove any references to it (check agent/instructions.md and update it if it mentions ${t}).`);
  const actions = useMemo(() => ({
    explain: (t) => actionsRef.current.explain(t),
    edit: (t) => actionsRef.current.edit(t),
    remove: (t) => actionsRef.current.remove(t),
  }), []);

  const { nodes, edges } = useMemo(() => toGraph(info, actions), [info, actions]);

  if (!project) return <div className="empty">Pick a project first — Build works on a local checkout.</div>;

  return (
    <div className="buildpage">
      <div className="buildcol chatmode">
        <OpencodeTerm project={project} />
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
