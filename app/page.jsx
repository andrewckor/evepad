"use client";

// Homepage: every agent as a card — live status, model, quick actions — plus
// creating a brand-new eve agent (scaffold + Vercel project + creds + dev
// server) behind one dialog.

import { useState, Suspense } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { I } from "./components/icons.jsx";
import { Badge } from "./components/badge.jsx";
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

// Vercel-dashboard-style project tile. eve apps ship no favicon (their HTTP
// surface 404s it), so the eve dot-grid mark is the identity — same glyph as
// the agent pill in the Build graph. Favicon kept as a progressive upgrade
// for any project that does serve one.
function EveMark() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
      {[[3,3],[8,2.5],[13,3],[2.5,8],[8,8],[13.5,8],[3,13],[8,13.5],[13,13]].map(([x,y],i)=>(
        <circle key={i} cx={x} cy={y} r={i%2?1.1:1.5} fill="currentColor"/>
      ))}
    </svg>
  );
}
function Logo({ p }) {
  // Priority: Vercel's own dashboard icon service (favicon-or-framework-logo,
  // official art), then stored avatar, then live favicon, then our mark.
  const sources = [p.iconUrl, p.avatarUrl, p.productionUrl ? `${p.productionUrl}/favicon.ico` : null].filter(Boolean);
  const [idx, setIdx] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const src = sources[idx] ?? null;
  const mark = p.framework === "eve"
    ? <EveMark />
    : <span className="mono" style={{ fontSize: 13 }}>{p.name.slice(0, 1).toUpperCase()}</span>;
  return (
    <span className="agentlogo">
      {src && (
        <img
          src={src} alt="" style={loaded ? {} : { display: "none" }}
          onLoad={() => setLoaded(true)}
          onError={() => { setLoaded(false); setIdx((i) => i + 1); }}
        />
      )}
      {!loaded && mark}
    </span>
  );
}
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
        <span className="dim">{projects.filter((p) => p.live).length} running locally</span>
      </div>
      <TooltipProvider delay={150}>
      <div className="agentgrid">
        <NewAgentCard onCreated={(name) => router.push(`/runs?project=${encodeURIComponent(name)}&environment=local`)} />
        {projects.map((p) => (
          <div key={p.name} className="agentcard" onClick={() => open(p)} role="button" tabIndex={0}>
            <div className="agentrow">
              <Logo p={p} />
              <b>{p.name}</b>
              <div className="spacer" />
              {busy[p.name] ? (
                <Tip label="Working on it — starting or stopping the dev server"><span className="devbtn busy">{I.loader}</span></Tip>
              ) : p.live ? (
                <Tip label={`Stop the local eve dev server on :${p.localPort}`}><span className="devbtn stop" onClick={(e) => devAction(e, p, "stop")}>{I.stop}</span></Tip>
              ) : p.localPath ? (
                <Tip label={`Start eve dev for ${p.name} — installs deps and pulls creds if needed`}><span className="devbtn play" onClick={(e) => devAction(e, p, "start")}>{I.play}</span></Tip>
              ) : (
                <Tip label={`Locate ${p.name}\u2019s checkout folder — enables start, Build and local runs`}><span className="devbtn locate" onClick={(e) => devAction(e, p, "locate")}>{I.folder}</span></Tip>
              )}
            </div>
            <div className="agentmeta">
              {p.live ? (
                <>
                  <Badge variant="green-subtle" size="sm" dot title={`eve dev serving on 127.0.0.1:${p.localPort}`}>Running <span className="mono">:{p.localPort}</span></Badge>
                  {p.model && <span className="cardfact mono dim2" title="Agent model"><Sparkles /> {p.model}</span>}
                </>
              ) : (
                <>
                  {/* Linked means "also lives in production", not mere link
                      plumbing — a checkout that never deployed reads Local
                      only even when .vercel/project.json exists. */}
                  <Badge variant="gray-subtle" size="sm" title={
                    p.localPath
                      ? (p.productionUrl ? "Checkout on this machine, deployed to Vercel production" : "Checkout on this machine, never deployed")
                      : "Vercel project with no checkout on this machine \u2014 use the folder button to connect one"
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
                  title={`Open ${p.productionUrl} in a new tab`}
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
