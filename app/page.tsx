"use client";

// Homepage: every agent as a card — live status, model, quick actions — plus
// creating a brand-new eve agent (scaffold + Vercel project + creds + dev
// server) behind one dialog.

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { I } from "./components/icons";
import { Badge } from "./components/badge";
import ProjectLogo from "./components/project-logo";
import { Globe, Sparkles } from "vercel-geist-icons";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import Welcome from "./components/welcome";
import NewAgentDialog from "./components/new-agent-dialog";

// Icon-only controls get real tooltips (instant, styled), not the browser's
// sluggish native title.
import type { Project, DevAction } from "@/lib/types";
import type { ReactNode, ReactElement, SyntheticEvent } from "react";

function Tip({ label, children }: { label: ReactNode; children: ReactElement }) {
  // Base UI trigger: custom elements go through `render`, not Radix asChild.
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

import { getJson as fetcher } from "@/lib/fetch";
import { ago as agoShared } from "@/lib/format";

// Cards floor at "1m ago" — "12s ago" churns for no information.
const ago = (ts: number | null | undefined) => {
  if (!ts) return "";
  const s = agoShared(ts);
  return s.endsWith("s ago") ? "1m ago" : s;
};

function NewAgentCard({ onOpen }: { onOpen: () => void }) {
  return (
    <button className="agentcard new" onClick={onOpen}>
      <span className="newplus">{I.plus}</span>
      <b>New Agent</b>
      <span className="dim2">
        Scaffold an eve agent, create its Vercel project, and boot it — one step.
      </span>
    </button>
  );
}

function Home() {
  const router = useRouter();
  const q = useSearchParams();
  const { data, mutate } = useSWR("/api/projects", fetcher, {
    refreshInterval: 5000,
    keepPreviousData: true,
  });
  const { data: account, mutate: recheck } = useSWR("/api/account", fetcher);
  const projects: Project[] = data?.projects ?? [];
  const [busy, setBusy] = useState<Record<string, string | undefined>>({});
  const [newOpen, setNewOpen] = useState(false);
  // Per-session only: a stored flag would outlive the reason for it.
  const [skipped, setSkipped] = useState(false);

  // First run resolves to exactly one of these. Never a stored flag: it would
  // lie after `vercel logout`, or on a second machine.
  //
  // ?firstrun=signed-out|empty|error forces a state in development. These
  // screens are unreachable on a working machine, and the alternative — moving
  // the CLI's auth.json aside to see one — is a bad thing to leave lying
  // around if anything crashes mid-check.
  const forced = process.env.NODE_ENV !== "production" ? q.get("firstrun") : null;
  // Signed out takes the page even when local dev servers were discovered:
  // half a list plus a chip reading "Not signed in" leaves you guessing which
  // agents are missing. Local-only users can skip past it — the agents behind
  // it genuinely work without Vercel.
  const signedOut = data && account && !account.loggedIn && !skipped;
  const firstRun =
    forced ||
    (signedOut
      ? "signed-out"
      : !projects.length && data && account && (data.error ? "error" : "empty"));
  const localCount = projects.filter((p) => p.source === "local" || p.live).length;

  const devAction = async (e: SyntheticEvent, p: Project, action: DevAction) => {
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

  const open = (p: Project) => router.push(`/runs?project=${encodeURIComponent(p.name)}`);

  // Nothing to show and a reason why: the whole page becomes that reason,
  // rather than a grid of one card next to a spinner that never stops.
  if (firstRun) {
    return (
      <div className="wrap">
        <div className="home-head">
          <h1>Agents</h1>
        </div>
        {/* Forcing signed-out forces the account away too, or the screen
            offers a confirmation for credentials it claims not to have. */}
        <Welcome
          state={firstRun}
          error={data?.error ?? "projects API 500"}
          account={forced === "signed-out" ? null : account}
          demo={Boolean(forced)}
          localCount={localCount}
          onRetry={() => {
            // Drop ?firstrun on the way out: the dev override must never
            // outrank a real sign-in and strand someone on this screen.
            if (forced) router.replace("/");
            recheck();
            mutate();
          }}
          onNew={() => setNewOpen(true)}
          onSkip={() => setSkipped(true)}
        />
        <NewAgentDialog open={newOpen} onOpenChange={setNewOpen} />
      </div>
    );
  }

  return (
    <div className="wrap">
      <div className="home-head">
        {/* No count until the list arrives — "0 Agents" during the first
            fetch reads as "you have none". */}
        <h1>{projects.length ? `${projects.length} Agents` : "Agents"}</h1>
        {projects.some((p) => p.live) && (
          <span className="dim">{projects.filter((p) => p.live).length} running locally</span>
        )}
      </div>
      <NewAgentDialog open={newOpen} onOpenChange={setNewOpen} />
      <TooltipProvider delay={150}>
        <div className="agentgrid">
          <NewAgentCard onOpen={() => setNewOpen(true)} />
          {projects.map((p) => (
            <div
              key={p.name}
              className="agentcard"
              onClick={() => open(p)}
              role="button"
              tabIndex={0}
            >
              <div className="agentrow">
                <ProjectLogo p={p} />
                <b>{p.name}</b>
                <div className="spacer" />
                {busy[p.name] ? (
                  <Tip label="Working…">
                    <span className="devbtn busy">{I.loader}</span>
                  </Tip>
                ) : p.live ? (
                  <Tip label="Stop local server">
                    <span className="devbtn stop" onClick={(e) => devAction(e, p, "stop")}>
                      {I.stop}
                    </span>
                  </Tip>
                ) : p.localPath ? (
                  <Tip label="Start local server">
                    <span className="devbtn play" onClick={(e) => devAction(e, p, "start")}>
                      {I.play}
                    </span>
                  </Tip>
                ) : (
                  <Tip label="Choose local folder">
                    <span className="devbtn locate" onClick={(e) => devAction(e, p, "locate")}>
                      {I.folder}
                    </span>
                  </Tip>
                )}
              </div>
              <div className="agentmeta">
                {p.live ? (
                  <>
                    <Badge variant="green-subtle" size="sm" dot title="Local server running">
                      Running <span className="mono">:{p.localPort}</span>
                    </Badge>
                    {p.model && (
                      <span className="cardfact mono dim2" title="Agent model">
                        <Sparkles /> {p.model}
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    {/* One fact only: is this agent's code on this Mac. Whether
                      it's deployed is already answered by the production URL
                      row below, and "Linked" tried to say both at once — the
                      same word Vercel uses for linking a project. */}
                    <Badge
                      variant="gray-subtle"
                      size="sm"
                      title={
                        p.localPath
                          ? `Folder on this Mac: ${p.localPath}`
                          : "No folder on this Mac — open Build to choose one"
                      }
                    >
                      {p.localPath ? "On this Mac" : "Remote only"}
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
      {!projects.length && !firstRun && <div className="empty">Looking for agents…</div>}
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
