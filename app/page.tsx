"use client";

// Homepage: every agent as a card — live status, model, quick actions — plus
// creating a brand-new eve agent (scaffold + Vercel project + creds + dev
// server) behind one dialog.

import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { I } from "./components/icons";
import { Badge } from "./components/badge";
import ProjectLogo from "./components/project-logo";
import { Check, Globe, Sparkles } from "vercel-geist-icons";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import DeployMenu from "./components/deploy-menu";
import Welcome from "./components/welcome";
import NewAgentDialog from "./components/new-agent-dialog";
import LoadingState from "./components/loading-state";

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
const BUSY_LABEL: Record<string, string> = {
  start: "Starting…",
  stop: "Stopping…",
  locate: "Choosing folder…",
};

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

function AgentLoadingChecklist({
  remoteLoading,
  discovering,
  foundCount,
  onSkip,
}: {
  remoteLoading: boolean;
  discovering: boolean;
  foundCount: number | null;
  onSkip: () => void;
}) {
  return (
    <div className="agent-load-wrap">
      <div className="agent-load-checklist" aria-live="polite">
        <div className="agent-load-step done">
          <span className="agent-load-icon">
            {remoteLoading ? <span className="th-spin" aria-hidden /> : <Check />}
          </span>
          <span>{remoteLoading ? "Loading remote agents" : "Loaded remote agents"}</span>
        </div>
        <div
          className={`agent-load-step${remoteLoading ? " pending" : discovering ? " active" : " done"}`}
        >
          <span className="agent-load-icon">
            {discovering ? <span className="th-spin" aria-hidden /> : <Check />}
          </span>
          <span>
            {discovering || foundCount === null
              ? "Scanning for local agents"
              : `${foundCount} local agent${foundCount === 1 ? "" : "s"} found`}
          </span>
        </div>
      </div>
      <button className="wc-skip agent-load-skip" onClick={onSkip}>
        Skip scanning for now
      </button>
    </div>
  );
}

function Home() {
  const router = useRouter();
  const q = useSearchParams();
  const [discoveryDismissed, setDiscoveryDismissed] = useState(false);
  const { data: discoveryBootstrap } = useSWR("/api/projects/discovery", fetcher, {
    revalidateOnFocus: false,
    revalidateIfStale: false,
  });
  const {
    data: account,
    mutate: recheck,
    isLoading: accountLoading,
  } = useSWR("/api/account", fetcher);
  const firstDiscovery = Boolean(discoveryBootstrap?.required);
  // Scope the SWR cache itself, not just the server cache. Otherwise a Vercel
  // account/team switch can briefly reuse the previous scope's project list
  // while the new request is in flight.
  const projectScope =
    account?.scope?.id ??
    account?.scope?.slug ??
    account?.user?.username ??
    (account?.loggedIn ? "signed-in" : null);
  const projectsKey =
    account?.loggedIn && projectScope
      ? `/api/projects?scope=${encodeURIComponent(projectScope)}`
      : null;
  const {
    data,
    mutate,
    isLoading: projectsLoading,
  } = useSWR(discoveryBootstrap ? projectsKey : null, fetcher, {
    refreshInterval: (latestData) => (latestData?.discovering ? 250 : 5000),
    keepPreviousData: true,
  });
  const projects: Project[] = data?.projects ?? [];
  const discovering = Boolean(data?.discovering);
  const discoveryFinished =
    firstDiscovery &&
    !discovering &&
    data?.discoveredAgents !== null &&
    data?.discoveredAgents != null;
  const [busy, setBusy] = useState<Record<string, string | undefined>>({});
  const [newOpen, setNewOpen] = useState(false);
  // After the CLI confirms a login, refresh account and projects as one UI
  // transition. Without this guard the account response can win the race and
  // briefly render the signed-in empty state before the agent list arrives.
  const [signInSyncing, setSignInSyncing] = useState(false);
  // Per-session only: a stored flag would outlive the reason for it.
  const [skipped, setSkipped] = useState(false);

  useEffect(() => {
    if (!discoveryFinished || discoveryDismissed) return;
    const timer = window.setTimeout(() => setDiscoveryDismissed(true), 1200);
    return () => window.clearTimeout(timer);
  }, [discoveryDismissed, discoveryFinished]);

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
  const signedOut = account && !account.loggedIn && !skipped;
  const firstRun =
    !projects.length && data && account && !discovering && (data.error ? "error" : "empty");
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
      // Refresh BEFORE dropping the spinner: the button flips straight from
      // working to the new state, never through the stale one.
      await mutate();
      setBusy((b) => ({ ...b, [p.name]: undefined }));
    }
  };

  const open = (p: Project) => router.push(`/runs?project=${encodeURIComponent(p.name)}`);

  // Authentication is the first gate. A signed-out user sees sign-in before
  // any filesystem discovery; the local scan begins only after login succeeds.
  if (accountLoading || !account) {
    return (
      <div className="wrap">
        <div className="home-loading plain">
          <LoadingState label="Loading remote agents" elapsed={false} />
        </div>
      </div>
    );
  }

  // Development previews are explicit and must remain reachable regardless of
  // the machine's real authentication state.
  if (forced) {
    return (
      <div className="wrap">
        <Welcome
          state={forced}
          error={data?.error ?? "projects API 500"}
          account={forced === "signed-out" ? null : account}
          demo
          onRetry={async () => {
            router.replace("/");
            setSignInSyncing(true);
            try {
              await Promise.all([recheck(), mutate()]);
            } finally {
              setSignInSyncing(false);
            }
          }}
          onNew={() => setNewOpen(true)}
          onSkip={() => setSkipped(true)}
        />
      </div>
    );
  }

  if (signedOut) {
    return (
      <div className="wrap">
        <Welcome
          state="signed-out"
          account={account}
          onRetry={async () => {
            setSignInSyncing(true);
            try {
              await Promise.all([recheck(), mutate()]);
            } finally {
              setSignInSyncing(false);
            }
          }}
          onNew={() => setNewOpen(true)}
          onSkip={() => setSkipped(true)}
        />
      </div>
    );
  }

  // Once signed in, determine whether this is the one-time local discovery.
  // Rendering either loader before that answer caused a one-frame flash of the
  // wrong surface.
  if (!discoveryBootstrap) return <div className="wrap" />;

  if (projectsLoading || signInSyncing || !data) {
    return (
      <div className="wrap">
        <div className={`home-loading${firstDiscovery && !discoveryDismissed ? "" : " plain"}`}>
          {firstDiscovery && !discoveryDismissed ? (
            <AgentLoadingChecklist
              remoteLoading
              discovering
              foundCount={null}
              onSkip={() => setDiscoveryDismissed(true)}
            />
          ) : (
            <LoadingState label="Loading remote agents" elapsed={false} />
          )}
        </div>
      </div>
    );
  }

  // The boxed checklist is a one-time discovery surface. Once the marker and
  // registry exist, ordinary refreshes use only the app's original pixel loader.
  if (firstDiscovery && !discoveryDismissed) {
    return (
      <div className="wrap">
        <div className="home-loading">
          <AgentLoadingChecklist
            remoteLoading={false}
            discovering={!discoveryFinished}
            foundCount={data?.discoveredAgents ?? null}
            onSkip={() => setDiscoveryDismissed(true)}
          />
        </div>
      </div>
    );
  }

  // Nothing to show and a reason why: the whole page becomes that reason,
  // rather than a grid of one card next to a spinner that never stops.
  if (firstRun) {
    return (
      <div className="wrap">
        {/* Forcing signed-out forces the account away too, or the screen
            offers a confirmation for credentials it claims not to have. */}
        <Welcome
          state={firstRun}
          error={data?.error ?? "projects API 500"}
          account={forced === "signed-out" ? null : account}
          demo={Boolean(forced)}
          localCount={localCount}
          onRetry={async () => {
            // Drop ?firstrun on the way out: the dev override must never
            // outrank a real sign-in and strand someone on this screen.
            if (forced) router.replace("/");
            setSignInSyncing(true);
            try {
              await Promise.all([recheck(), mutate()]);
            } finally {
              setSignInSyncing(false);
            }
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
            <article key={p.name} className="agentcard">
              <button
                type="button"
                className="agentcard-main"
                onClick={() => open(p)}
                aria-label={`Open runs for ${p.name}`}
              >
                <div className="agentrow">
                  <ProjectLogo p={p} />
                  <b>{p.name}</b>
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
              </button>
              <div className="agent-actions">
                {p.localPath && !busy[p.name] && <DeployMenu project={p.name} compact />}
                {busy[p.name] ? (
                  <Tip label={BUSY_LABEL[busy[p.name] ?? ""] ?? "Working…"}>
                    <span className="devbtn busy">
                      <span className="th-spin" />
                    </span>
                  </Tip>
                ) : p.live ? (
                  <Tip label="Stop local server">
                    <button
                      type="button"
                      className="devbtn stop"
                      aria-label="Stop local server"
                      onClick={(e) => devAction(e, p, "stop")}
                    >
                      {I.stop}
                    </button>
                  </Tip>
                ) : p.localPath ? (
                  <Tip label="Start local server">
                    <button
                      type="button"
                      className="devbtn play"
                      aria-label="Start local server"
                      onClick={(e) => devAction(e, p, "start")}
                    >
                      {I.play}
                    </button>
                  </Tip>
                ) : (
                  <Tip label="Choose local folder">
                    <button
                      type="button"
                      className="devbtn locate"
                      aria-label="Choose local folder"
                      onClick={(e) => devAction(e, p, "locate")}
                    >
                      {I.folder}
                    </button>
                  </Tip>
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
                    style={{ overflow: "hidden", textOverflow: "ellipsis" }}
                  >
                    <Globe /> {p.productionUrl.replace(/^https?:\/\//, "")}
                  </a>
                )}
              </div>
            </article>
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
