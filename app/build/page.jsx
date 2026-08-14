"use client";

// Build — a conversational coding surface for the agent, beside a live map.
// Left: chat whose tools read and edit the agent's code (GLM via AI Gateway,
// the project's own creds). Right: React Flow graph in Vercel's layout —
// Tools box + category pills converging into the agent pill, channels below.
// Writes refresh the graph, so generated tools appear as rows moments later.

import { useState, useMemo, useRef, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { ReactFlow, Background, Controls } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Streamdown } from "streamdown";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Copy, Pencil, Trash } from "vercel-geist-icons";

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
          <div className="box-title">Tools</div>
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

  const { data: info, error: infoErr, isLoading: infoLoading, mutate: refetchInfo } = useSWR(
    project ? `/api/agent-info?project=${encodeURIComponent(project)}` : null,
    fetcher,
    { refreshInterval: 3000, revalidateOnFocus: true, keepPreviousData: true },
  );

  // Model picker: everything the OpenCode server can route to (gateway first).
  const { data: modelData } = useSWR(
    project ? `/api/build-models?project=${encodeURIComponent(project)}` : null,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 60_000 },
  );
  const models = modelData?.models ?? [];
  const [modelKey, setModelKey] = useState(null); // "providerID:modelID"
  useEffect(() => {
    if (modelKey || !models.length) return;
    const saved = sessionStorage.getItem("build-model");
    const pick = models.find((m) => `${m.providerID}:${m.modelID}` === saved)
      ?? models.find((m) => m.default) ?? models[0];
    setModelKey(`${pick.providerID}:${pick.modelID}`);
  }, [models, modelKey]);
  const selModel = models.find((m) => `${m.providerID}:${m.modelID}` === modelKey);

  // Chat state: [{role, content, events?, writes?, diagnostics?}]
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const scroller = useRef(null);
  const busyRef = useRef(false);

  useEffect(() => {
    scroller.current?.scrollTo(0, scroller.current.scrollHeight);
  }, [messages, busy]);

  const send = async (text) => {
    const content = (text ?? input).trim();
    if (!content || busyRef.current) return;
    busyRef.current = true;
    setInput("");
    setError(null);
    // Build history from the closure value — never from inside a state updater;
    // updaters run later (and twice in StrictMode), so assigning out of one
    // leaves the variable undefined here.
    const history = [...messages, { role: "user", content }];
    setMessages(history);
    setBusy(true);
    try {
      const r = await fetch("/api/build-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project,
          messages: history.map(({ role, content }) => ({ role, content })),
          provider: selModel?.providerID,
          model: selModel?.modelID,
        }),
      });
      if (!r.ok) { setError((await r.json()).error); return; }

      // NDJSON stream: grow the assistant message in place as frames arrive.
      setMessages((m) => [...m, { role: "assistant", content: "", events: [], streaming: true }]);
      const patch = (fn) => setMessages((m) => {
        const last = m[m.length - 1];
        return [...m.slice(0, -1), fn(last)];
      });
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let f;
          try { f = JSON.parse(line); } catch { continue; }
          if (f.type === "delta") {
            patch((last) => ({ ...last, content: last.content + f.text }));
          } else if (f.type === "tool") {
            patch((last) => ({ ...last, events: [...last.events, { tool: f.tool, path: f.path }] }));
          } else if (f.type === "status") {
            patch((last) => ({ ...last, status: f.label }));
          } else if (f.type === "done") {
            patch((last) => ({
              ...last,
              // Deltas can double-render across steps; the done frame's text is
              // authoritative. Keep streamed text only until it arrives.
              content: f.text ?? last.content,
              events: f.events?.length ? f.events : last.events,
              writes: f.writes,
              diagnostics: f.diagnostics,
              engine: f.engine,
              model: f.model,
              fallbackReason: f.fallbackReason ?? null,
              status: null,
              streaming: false,
            }));
            if (f.writes?.length) {
              fetch(`/api/agent-info?project=${encodeURIComponent(project)}&fresh=1`).then(() => refetchInfo());
            }
          } else if (f.type === "error") {
            setError(f.error);
            patch((last) => ({ ...last, streaming: false, status: null }));
          }
        }
      }
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };

  const revert = async (w) => {
    await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, action: "apply", path: w.path, code: w.previous ?? "" }),
    });
    setMessages((m) => [...m, { role: "assistant", content: `Reverted \`${w.path}\`.`, events: [], writes: [] }]);
    fetch(`/api/agent-info?project=${encodeURIComponent(project)}&fresh=1`).then(() => refetchInfo());
  };

  // Stable identity so the graph doesn't rebuild per keystroke.
  const actionsRef = useRef({});
  actionsRef.current.explain = (t) => send(`What does agent/tools/${t}.ts do? Show the important part of the code briefly.`);
  actionsRef.current.edit = (t) => setInput(`Edit agent/tools/${t}.ts: `);
  actionsRef.current.remove = (t) =>
    send(`Delete the tool agent/tools/${t}.ts and remove any references to it (check agent/instructions.md and update it if it mentions ${t}).`);
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
        <div className="buildchat" ref={scroller}>
          {!messages.length && (
            <div className="chat-empty">
              <div className="dim">Build chat for <b>{project}</b> — ask about the agent or tell it what to change.
                It edits code through tools (<span className="mono">read_file</span>, <span className="mono">write_file</span>),
                scoped to the agent surface, with revert on every write.</div>
              <div className="dim2">Model: <span className="mono">{selModel ? selModel.modelID : "zai/glm-5.2"}</span>{selModel?.providerID === "vercel" ? " via AI Gateway." : "."}</div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={"bmsg " + m.role}>
              {(m.events ?? []).map((e, j) => (
                <div key={j} className="msg-tool mono">✓ {e.tool}{e.path ? ` ${e.path}` : ""}</div>
              ))}
              {m.content && (m.role === "assistant"
                ? <Streamdown className="chat-md">{m.content}</Streamdown>
                : <div className="bmsg-user">{m.content}</div>)}
              {(m.writes ?? []).map((w, j) => (
                <div key={j} className={"write-chip" + (w.deleted ? " deleted" : "")}>
                  <span className="mono">{w.deleted ? "deleted " : ""}{w.path}</span>
                  <Button variant="ghost" size="sm" onClick={() => revert(w)}>Revert</Button>
                </div>
              ))}
              {m.status && (
                <div className="dim mono" style={{ fontSize: 12 }}>{m.status}…</div>
              )}
              {m.diagnostics && (
                <div className={"mono " + (m.diagnostics.errors === 0 ? "ok" : "warn")} style={{ fontSize: 12 }}>
                  diagnostics: {m.diagnostics.errors === 0 ? "clean" : `${m.diagnostics.errors} error(s)`}
                </div>
              )}
              {m.role === "assistant" && m.engine && !m.streaming && (
                <div className="msg-engine mono">{m.engine}{m.fallbackReason ? " (fallback)" : ""} · {m.model}</div>
              )}
            </div>
          ))}
          {busy && !messages[messages.length - 1]?.streaming && (
            <div className="dim mono" style={{ display: "flex", gap: 8, alignItems: "center" }}><Spinner /> working…</div>
          )}
          {error && <div className="bad" style={{ fontSize: 13 }}>{error}</div>}
        </div>
        <div className="chat-composer">
          <div className="chat-input">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder={busy ? "working…" : `Ask or change ${project}…`}
              disabled={busy}
              autoFocus
            />
            <button onClick={() => send()} disabled={busy || !input.trim()}>↩</button>
          </div>
          {models.length > 0 && (
            <div className="chat-model">
              <button
                className="oc-btn mono"
                title="Open the OpenCode TUI in a terminal on this checkout (gateway model preset)"
                onClick={() => window.dispatchEvent(new CustomEvent("cockpit:open-terminal", { detail: { variant: "opencode" } }))}
              >opencode ↗</button>
              <select
                value={modelKey ?? ""}
                onChange={(e) => { setModelKey(e.target.value); sessionStorage.setItem("build-model", e.target.value); }}
                disabled={busy}
                aria-label="Model"
              >
                {[...new Set(models.map((m) => m.provider))].map((prov) => (
                  <optgroup key={prov} label={prov}>
                    {models.filter((m) => m.provider === prov).map((m) => (
                      <option key={`${m.providerID}:${m.modelID}`} value={`${m.providerID}:${m.modelID}`}>
                        {m.name}{m.free ? " · free" : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          )}
        </div>
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
