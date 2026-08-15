"use client";

// Homepage: every agent as a card — live status, model, quick actions — plus
// creating a brand-new eve agent (scaffold + Vercel project + creds + dev
// server) behind one dialog.

import { useState, Suspense } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { I } from "./components/icons.jsx";
import { Badge } from "./components/badge.jsx";
import ProjectLogo from "./components/project-logo.jsx";
import { Globe, Sparkles } from "vercel-geist-icons";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";

// Icon-only controls get real tooltips (instant, styled), not the browser's
// sluggish native title.
function Tip({ label, children }) {
  // Base UI trigger: custom elements go through `render`, not Radix asChild.
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

const fetcher = (url) => fetch(url).then((r) => r.json());
const ago = (ts) => {
  if (!ts) return "";
  const s = (Date.now() - ts) / 1000;
  if (s < 3600) return Math.max(1, Math.floor(s / 60)) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
};

function NewAgentCard({ onCreated }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phase, setPhase] = useState(null); // null | "creating" | error string
  const valid = /^[a-z][a-z0-9-]{1,40}$/.test(name);

  const create = async () => {
    if (!valid || phase === "creating") return;
    setPhase("creating");
    const r = await fetch("/api/create-agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const body = await r.json();
    if (!r.ok) { setPhase(body.error ?? "failed"); return; }
    onCreated(name);
  };

  if (!open) {
    return (
      <button className="agentcard new" onClick={() => setOpen(true)}>
        <span className="newplus">{I.plus}</span>
        <b>New Agent</b>
        <span className="dim2">Scaffold an eve agent, create its Vercel project, and boot it — one step.</span>
      </button>
    );
  }
  return (
    <div className="agentcard">
      <b>New Agent</b>
      <input
        className="newinput"
        placeholder="agent-name (kebab-case)"
        value={name}
        autoFocus
        onChange={(e) => { setName(e.target.value); if (typeof phase === "string" && phase !== "creating") setPhase(null); }}
        onKeyDown={(e) => e.key === "Enter" && create()}
        disabled={phase === "creating"}
      />
      <span className="dim2" style={{ fontSize: 12 }}>
        Creates <span className="mono">~/eve-agents/{name || "…"}</span>, a Vercel project of the same name,
        pulls AI Gateway creds, and starts <span className="mono">eve dev</span>. Model: <span className="mono">zai/glm-5.2</span> (free).
      </span>
      {phase === "creating" ? (
        <span className="warn" style={{ fontSize: 13 }}>Creating — scaffold, link, creds, boot (~1 min)…</span>
      ) : typeof phase === "string" && phase ? (
        <span className="bad" style={{ fontSize: 12.5 }}>{phase}</span>
      ) : null}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="chatbtn" onClick={create} disabled={!valid || phase === "creating"}>Create</button>
        <button className="chatbtn" onClick={() => { setOpen(false); setPhase(null); }} disabled={phase === "creating"}>Cancel</button>
      </div>
    </div>
  );
}

function Home() {
  const router = useRouter();
  const { data, mutate } = useSWR("/api/projects", fetcher, { refreshInterval: 5000, keepPreviousData: true });
  const projects = data?.projects ?? [];
  const [busy, setBusy] = useState({});

  const devAction = async (e, p, action) => {
    e.stopPropagation();
    setBusy((b) => ({ ...b, [p.name]: action }));
    try {
      const r = await fetch("/api/dev", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: p.name, action }),
      });
      const body = await r.json();
      if (!r.ok) alert(body.error ?? "failed");
    } finally {
      setBusy((b) => ({ ...b, [p.name]: undefined }));
      mutate();
    }
  };

  const open = (p) => router.push(`/runs?project=${encodeURIComponent(p.name)}`);

  return (
    <div className="wrap">
      <div className="home-head">
        <h1>{projects.length} Agents</h1>
        {projects.some((p) => p.live) && (
          <span className="dim">{projects.filter((p) => p.live).length} running locally</span>
        )}
      </div>
      <TooltipProvider delay={150}>
      <div className="agentgrid">
        <NewAgentCard onCreated={(name) => router.push(`/runs?project=${encodeURIComponent(name)}&environment=local`)} />
        {projects.map((p) => (
          <div key={p.name} className="agentcard" onClick={() => open(p)} role="button" tabIndex={0}>
            <div className="agentrow">
              <ProjectLogo p={p} />
              <b>{p.name}</b>
              <div className="spacer" />
              {busy[p.name] ? (
                <Tip label="Working…"><span className="devbtn busy">{I.loader}</span></Tip>
              ) : p.live ? (
                <Tip label="Stop local server"><span className="devbtn stop" onClick={(e) => devAction(e, p, "stop")}>{I.stop}</span></Tip>
              ) : p.localPath ? (
                <Tip label="Start local server"><span className="devbtn play" onClick={(e) => devAction(e, p, "start")}>{I.play}</span></Tip>
              ) : (
                <Tip label="Link local project"><span className="devbtn locate" onClick={(e) => devAction(e, p, "locate")}>{I.folder}</span></Tip>
              )}
            </div>
            <div className="agentmeta">
              {p.live ? (
                <>
                  <Badge variant="green-subtle" size="sm" dot title="Local server running">Running <span className="mono">:{p.localPort}</span></Badge>
                  {p.model && <span className="cardfact mono dim2" title="Agent model"><Sparkles /> {p.model}</span>}
                </>
              ) : (
                <>
                  {/* Linked means "also lives in production", not mere link
                      plumbing — a checkout that never deployed reads Local
                      only even when .vercel/project.json exists. */}
                  <Badge variant="gray-subtle" size="sm" title={
                    p.localPath
                      ? (p.productionUrl ? "Local checkout, deployed" : "Local checkout, not deployed")
                      : "No local checkout"
                  }>
                    {p.localPath ? (p.productionUrl ? "Linked" : "Local only") : "Remote only"}
                  </Badge>
                  {p.updatedAt && <span className="dim2">{ago(p.updatedAt)}</span>}
                </>
              )}
            </div>
            <div className="agentmeta agenturl">
              {p.productionUrl && (
                <a
                  className="cardfact carddomain dim2"
                  href={p.productionUrl}
                  target="_blank"
                  rel="noreferrer"
                  title="Open deployment"
                  onClick={(e) => e.stopPropagation() /* don't also open the card's runs view */}
                  style={{ overflow: "hidden", textOverflow: "ellipsis" }}
                >
                  <Globe /> {p.productionUrl.replace(/^https?:\/\//, "")}
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
      </TooltipProvider>
      {!projects.length && <div className="empty">Looking for agents…</div>}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="empty">Loading…</div>}>
      <Home />
    </Suspense>
  );
}
