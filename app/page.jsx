"use client";

// Homepage: every agent as a card — live status, model, quick actions — plus
// creating a brand-new eve agent (scaffold + Vercel project + creds + dev
// server) behind one dialog.

import { useState, Suspense } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { I } from "./components/icons.jsx";
import { Badge } from "./components/badge.jsx";

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
      <div className="agentgrid">
        <NewAgentCard onCreated={(name) => router.push(`/runs?project=${encodeURIComponent(name)}&environment=local`)} />
        {projects.map((p) => (
          <div key={p.name} className="agentcard" onClick={() => open(p)} role="button" tabIndex={0}>
            <div className="agentrow">
              <Logo p={p} />
              <b>{p.name}</b>
              <div className="spacer" />
              {busy[p.name] ? (
                <span className="devbtn busy">{I.loader}</span>
              ) : p.live ? (
                <span className="devbtn stop" title="Stop local server" onClick={(e) => devAction(e, p, "stop")}>{I.stop}</span>
              ) : p.localPath ? (
                <span className="devbtn play" title="Start eve dev" onClick={(e) => devAction(e, p, "start")}>{I.play}</span>
              ) : (
                <span className="devbtn locate" title="Connect a local checkout" onClick={(e) => devAction(e, p, "locate")}>{I.folder}</span>
              )}
            </div>
            <div className="agentmeta">
              {p.live ? (
                <>
                  <Badge variant="green-subtle" size="sm" dot>Running <span className="mono">:{p.localPort}</span></Badge>
                  {p.model && <span className="mono dim2">{p.model}</span>}
                </>
              ) : (
                <>
                  <Badge variant="gray-subtle" size="sm">{p.localPath ? "Stopped" : "Remote"}</Badge>
                  {p.updatedAt && <span className="dim2">{ago(p.updatedAt)}</span>}
                </>
              )}
            </div>
            <div className="agentmeta">
              {p.productionUrl && <span className="dim2 mono" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{p.productionUrl.replace(/^https?:\/\//, "")}</span>}
            </div>
          </div>
        ))}
      </div>
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
