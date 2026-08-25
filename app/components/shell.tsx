"use client";

// Persistent app shell: topbar, tabs, chat + terminal panels. Rendered once in
// the root layout and NEVER remounted on navigation — that is what removes the
// refetch flash and layout shift between pages. Route-specific bits (tabs, env
// badge) adapt from the URL rather than living in the pages.

import React, { Suspense, useState, useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import useSWR, { SWRConfig } from "swr";
import { AnimatePresence, LazyMotion, m as M } from "motion/react";

// One spring for every panel/push animation so they move as a single surface.
// High damping = fast, organic settle, no bounce, nothing linear.
import { SPRING } from "./motion";
import dynamic from "next/dynamic";
import ProjectPicker from "./project-picker";
import { EnvBadge } from "./badge";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import AccountMenu from "./account-menu";
import DeployMenu from "./deploy-menu";
const ChatPanel = dynamic(() => import("@/app/chat-panel"), { ssr: false });

import { I } from "./icons";
import { warmMd } from "./md";

const TerminalPanel = dynamic(() => import("../terminal-panel"), { ssr: false });

// Ends only — the copy button beside it hands over the whole id.
const shortRunId = (id: string | null | undefined): string => {
  const bare = (id ?? "").replace(/^wrun_/, "");
  return bare.length > 12 ? `${bare.slice(0, 5)}\u2026${bare.slice(-4)}` : bare;
};

// Hovering the button is the cheapest moment to fetch the terminal's chunks —
// xterm is the heaviest thing evepad lazy-loads (bundle-preload).
let buildWarmed = false;
let lastBootKick = 0;
const warmBuild = (name?: string) => {
  if (!buildWarmed) {
    buildWarmed = true;
    import("../components/agent-graph");
    import("../components/oc-chat");
  }
  // Kick the server work too: the opencode spawn and the `eve info` compile
  // are the seconds the user otherwise pays AFTER landing on Build. Both
  // routes background and dedupe, so a lost hover costs nothing.
  if (!name || Date.now() - lastBootKick < 15_000) return;
  lastBootKick = Date.now();
  const q = `project=${encodeURIComponent(name)}`;
  fetch(`/api/oc/state?${q}`).catch(() => {});
  fetch(`/api/agent-info?${q}`).catch(() => {});
};

let termWarmed = false;
const warmTerminal = () => {
  if (termWarmed) return;
  termWarmed = true;
  import("../terminal-panel");
  import("@xterm/xterm");
  import("@xterm/addon-fit");
};

import type { Project, Dock } from "@/lib/types";
import type { ReactNode, ReactElement } from "react";

type Panel = "chat" | "terminal" | null;
type TerminalRequest = { input: string; id: number };

import { getJson as fetcher } from "@/lib/fetch";
const DEFAULT_PERIOD = "12h";

// The environment preference lives in localStorage under the key the Runs page
// writes (see app/runs/page.jsx). Read defensively: this runs on the server
// during SSR, where there is no storage.
const ENV_KEY = "evepad:env2";
const ENV_DEFAULT = "local,preview,production";
function readEnvPref() {
  if (typeof window === "undefined") return ENV_DEFAULT;
  try {
    return localStorage.getItem(ENV_KEY) || localStorage.getItem("eve-cockpit:env2") || ENV_DEFAULT;
  } catch {
    return ENV_DEFAULT;
  }
}

// Icon-only controls need a real tooltip: at narrow widths the label IS the
// tooltip, and the native title is both slow and unstyled.
function Tip({ label, children }: { label: ReactNode; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function TopNav({
  panel,
  setPanel,
  clearTerminalInput,
  liveProject,
  termProject,
}: {
  panel: Panel;
  setPanel: React.Dispatch<React.SetStateAction<Panel>>;
  clearTerminalInput: () => void;
  liveProject: Project | null | undefined;
  termProject: Project | null | undefined;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const q = useSearchParams();

  // No URL param means "whatever the global preference is" — NOT local. The
  // old default silently rewrote the selection into every link the shell
  // builds, so switching projects from a page without the param (Build, a run
  // detail, the Agents grid) dropped an All-Environments user down to Local.
  // Runs owns the preference; the shell only carries it.
  //
  // Read after mount, not during render: this component is server-rendered,
  // and reaching for localStorage there is a hydration mismatch.
  const [envPref, setEnvPref] = useState(ENV_DEFAULT);
  // localStorage is the external system here; reading it during SSR/render is
  // a hydration mismatch, so it lands in state after mount.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    setEnvPref(readEnvPref());
  }, [pathname, q]);
  const environment = q.get("environment") ?? envPref;
  const period = q.get("period") ?? DEFAULT_PERIOD;
  const project = q.get("project") ?? "";

  const isDetail = pathname.startsWith("/run/");
  const isHome = pathname === "/";
  const isBuild = pathname === "/build";
  const runId = isDetail ? decodeURIComponent(pathname.split("/")[2] ?? "") : null;

  const listHref = (patch = {}) => {
    const next = new URLSearchParams({ environment, period, project, ...patch });
    return "/runs?" + next.toString();
  };

  // Switching projects keeps you on the page you're on (Build stays Build,
  // Runs stays Runs). A run DETAIL is the exception: the id belongs to one
  // project only, so it falls back to the new project's run list.
  // The environment selection is a GLOBAL setting — never rewritten here; the
  // data layer degrades gracefully when an env has nothing for the project.
  const pickProject = (p: Project) =>
    router.push(
      isBuild
        ? `/build?project=${encodeURIComponent(p.name)}&environment=${environment}&period=${period}`
        : listHref({ project: p.name }),
    );

  return (
    <>
      <div className="topbar">
        <TooltipProvider delay={300}>
          <AccountMenu />
          <ProjectPicker value={project} onChange={pickProject} />
          {/* Project-level actions live here so they're reachable from any view. */}
          {/* Two views of one agent, so they read as a mode rather than as two
            buttons that swap places depending on where you already are. */}
          {!isHome && termProject && (
            <div className="navtabs">
              {/* Labelled even when the label is showing: below 900px these
                collapse to bare icons and the tooltip is all there is. */}
              <Tip label="Runs">
                <Link className="tab" data-on={isBuild ? "0" : "1"} href={listHref()}>
                  {I.clockDashed} <span className="btn-label">Runs</span>
                </Link>
              </Tip>
              <Tip label="Build">
                <Link
                  className="tab"
                  data-on={isBuild ? "1" : "0"}
                  onMouseEnter={() => warmBuild(termProject.name)}
                  onFocus={() => warmBuild(termProject.name)}
                  href={`/build?project=${encodeURIComponent(termProject.name)}&environment=${environment}&period=${period}`}
                >
                  {I.bolt} <span className="btn-label">Build</span>
                </Link>
              </Tip>
            </div>
          )}
          <div className="spacer" />
          <div className="crumbstack">
            {/* layout="position" animates only where the title sits, never its
              box — so the run-id subtitle still pushes it up smoothly, while
              swapping "Agent Runs" for "Build" no longer squeezes the width. */}
            <M.div layout="position" transition={SPRING} className="crumb-title">
              {isDetail ? (
                <Link className="crumb-back" href={listHref()}>
                  <span className="crumb-back-ico">{I.chevLeft}</span>Agent Runs
                </Link>
              ) : (
                <span>{isHome ? "Agents" : isBuild ? "Build" : "Agent Runs"}</span>
              )}
            </M.div>
            {/* popLayout pulls the exiting subtitle out of flow immediately, so
              the title measures its new position on that same render and
              animates down. Plain exit unmounts only AFTER its animation, and
              the title had no render left to animate with — it jumped. */}
            <AnimatePresence mode="popLayout">
              {isDetail && (
                <M.div
                  layout="position"
                  className="crumb-sub"
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 5 }}
                  transition={SPRING}
                >
                  <EnvBadge env={environment} />
                  <span className="mono" title={runId ?? ""}>
                    {shortRunId(runId)}
                  </span>
                  <button
                    className="copybtn"
                    title="Copy run id"
                    onClick={() => navigator.clipboard?.writeText(runId ?? "")}
                  >
                    {I.copy}
                  </button>
                </M.div>
              )}
            </AnimatePresence>
          </div>
          {!isHome && termProject && (
            <span className="deploy-slot">
              <DeployMenu project={termProject.name} />
            </span>
          )}
          {!isHome && liveProject && (
            <Tip label={panel === "chat" ? "Close chat" : "Chat with your agent"}>
              <button
                className="chatbtn"
                data-on={panel === "chat" ? "1" : "0"}
                onClick={() => setPanel((p) => (p === "chat" ? null : "chat"))}
              >
                {I.message} <span className="btn-label">Chat</span>
              </button>
            </Tip>
          )}
          {!isHome && termProject && (
            <Tip label={panel === "terminal" ? "Close the eve CLI" : "Open the eve CLI"}>
              <button
                className="chatbtn"
                data-on={panel === "terminal" ? "1" : "0"}
                onMouseEnter={warmTerminal}
                onFocus={warmTerminal}
                onClick={() => {
                  clearTerminalInput();
                  setPanel((p) => (p === "terminal" ? null : "terminal"));
                }}
              >
                {I.terminal} <span className="btn-label">CLI</span>
              </button>
            </Tip>
          )}
        </TooltipProvider>
      </div>
    </>
  );
}

function ShellInner({ children }: { children: ReactNode }) {
  const q = useSearchParams();
  const router = useRouter();
  const project = q.get("project") ?? "";

  // One companion-panel slot: chat OR terminal, never both.
  const [panel, setPanel] = useState<Panel>(null);
  const [terminalRequest, setTerminalRequest] = useState<TerminalRequest>();
  const [chatKey, setChatKey] = useState(0);
  const [chatSeed, setChatSeed] = useState<string | null>(null);
  // Terminal sidebar width lives here so the whole frame can shrink for it —
  // the terminal PUSHES content instead of overlapping it.
  const [termWidth, setTermWidth] = useState(380);
  const [termHeight, setTermHeight] = useState(340);
  const [termDock, setTermDock] = useState<Dock>("right");
  const [resizing, setResizing] = useState(false);
  // Cap: never more than 50% of the viewport, unless the screen is wide enough
  // to leave >=700px of content. Re-clamped on window resize so a width saved on
  // a big display can't swallow a laptop screen.
  const clampW = (w: number) =>
    Math.min(Math.max(w, 380), Math.max(window.innerWidth * 0.5, window.innerWidth - 700));
  const clampH = (h: number) => Math.min(Math.max(h, 200), window.innerHeight * 0.6);
  useEffect(() => {
    const w = Number(sessionStorage.getItem("termWidth"));
    if (w) setTermWidth(clampW(w));
    const h = Number(sessionStorage.getItem("termHeight"));
    if (h) setTermHeight(clampH(h));
    const d = sessionStorage.getItem("termDock");
    if (d === "bottom" || d === "right") setTermDock(d);
    const onResize = () => {
      setTermWidth((c) => clampW(c));
      setTermHeight((c) => clampH(c));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const setDock = (d: Dock) => {
    setTermDock(d);
    sessionStorage.setItem("termDock", d);
  };

  // Once the page is idle, pull the deferred chunks (markdown pipeline, chat
  // panel) so their first real use doesn't pay the download.
  useEffect(() => {
    const warm = () => {
      warmMd();
      import("@/app/chat-panel");
    };
    if ("requestIdleCallback" in window) {
      const id = requestIdleCallback(warm);
      return () => cancelIdleCallback(id);
    }
    const t = setTimeout(warm, 2000);
    return () => clearTimeout(t);
  }, []);

  const { data: projData } = useSWR("/api/projects", fetcher, {
    refreshInterval: 5000,
    keepPreviousData: true,
  });
  const projects: Project[] = projData?.projects ?? [];
  const liveProject =
    projects.find((p) => p.name === (project || undefined) && p.live) ??
    projects.find((p) => p.live && !project);
  // The terminal follows the SELECTED project only — never another project's
  // server. With no selection yet, the live one stands in.
  const termProject = project
    ? (projects.find((p) => p.name === project && p.localPath) ?? null)
    : (liveProject ?? null);

  // Switching to a project whose server isn't running hides the panel; opening
  // the terminal by hand on a stopped project still works (that click starts it).
  useEffect(() => {
    setPanel((p) => {
      if (p === "terminal" && !termProject?.live) return null;
      if (p === "chat" && !liveProject) return null;
      return p;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  // ?panel=terminal — how "create an agent" hands over: the sidebar opening is
  // what starts eve dev, visibly. Declared after the guard above so it wins on
  // the same render (that guard closes the panel for a server that isn't live
  // yet, which a brand-new agent never is), and the param is dropped so a
  // refresh doesn't reopen it.
  const wantPanel = q.get("panel");
  useEffect(() => {
    if (wantPanel !== "terminal") return;
    setPanel("terminal");
    const next = new URLSearchParams(q.toString());
    next.delete("panel");
    router.replace(`${window.location.pathname}?${next}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantPanel]);

  useEffect(() => {
    const openAddTerminal = (event: Event) => {
      const kind = (event as CustomEvent<{ kind?: string }>).detail?.kind;
      if (kind !== "channel" && kind !== "connection") return;
      // Escape any open picker, then submit the native add command again.
      // A distinct id remounts the view so repeated graph clicks are delivered
      // to the existing Eve TUI instead of being swallowed by React state.
      setTerminalRequest({
        input: kind === "channel" ? "open-channels" : "reset-add",
        id: Date.now(),
      });
      setPanel("terminal");
    };
    window.addEventListener("terminal:add", openAddTerminal);
    return () => window.removeEventListener("terminal:add", openAddTerminal);
  }, []);

  // The chat and terminal both belong to ONE agent, so they close when there
  // is no agent in view: the Agents list has no project, and leaving a
  // terminal open over it showed a session for whichever agent you last
  // visited. Build deliberately keeps the terminal available: graph add
  // affordances open a focused CLI session in the same sidebar.
  const pathname = usePathname();
  useEffect(() => {
    if (!project) setPanel(null);
  }, [pathname, project]);

  const pushed = (panel === "terminal" && termProject) || (panel === "chat" && liveProject);
  return (
    <>
      <M.div
        className="frame"
        animate={{
          paddingRight: pushed && termDock === "right" ? termWidth : 0,
          paddingBottom: pushed && termDock === "bottom" ? termHeight : 0,
        }}
        transition={resizing ? { duration: 0 } : SPRING}
      >
        <TopNav
          panel={panel}
          setPanel={setPanel}
          clearTerminalInput={() => setTerminalRequest(undefined)}
          liveProject={liveProject}
          termProject={termProject}
        />
        {children}
      </M.div>
      <AnimatePresence>
        {panel === "chat" && liveProject && (
          <ChatPanel
            key={liveProject.name + liveProject.localPort + ":" + chatKey}
            project={liveProject}
            dock={termDock}
            onDock={setDock}
            size={termDock === "right" ? termWidth : termHeight}
            onSize={termDock === "right" ? setTermWidth : setTermHeight}
            clamp={termDock === "right" ? clampW : clampH}
            onResizing={setResizing}
            onNewChat={() => {
              setChatSeed(null);
              setChatKey((k) => k + 1);
            }}
            seed={chatSeed}
            onClose={() => setPanel(null)}
          />
        )}
        {panel === "terminal" && termProject && (
          <TerminalPanel
            key={termProject.name + (terminalRequest?.id ?? "eve")}
            project={termProject}
            initialInput={terminalRequest?.input}
            dock={termDock}
            onDock={setDock}
            size={termDock === "right" ? termWidth : termHeight}
            onSize={termDock === "right" ? setTermWidth : setTermHeight}
            clamp={termDock === "right" ? clampW : clampH}
            onResizing={setResizing}
            onClose={() => {
              setTerminalRequest(undefined);
              setPanel(null);
            }}
          />
        )}
      </AnimatePresence>
    </>
  );
}

// Animation features arrive async — the initial bundle carries only the m
// components; strict mode keeps a full `motion.` import from sneaking back in.
const loadMotion = () => import("./motion-features").then((x) => x.default);

export default function Shell({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ fetcher, keepPreviousData: true, revalidateOnFocus: false }}>
      <LazyMotion features={loadMotion} strict>
        <Suspense fallback={<div className="topbar" />}>
          <ShellInner>{children}</ShellInner>
        </Suspense>
      </LazyMotion>
    </SWRConfig>
  );
}
