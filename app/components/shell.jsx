"use client";

// Persistent app shell: topbar, tabs, chat + terminal panels. Rendered once in
// the root layout and NEVER remounted on navigation — that is what removes the
// refetch flash and layout shift between pages. Route-specific bits (tabs, env
// badge) adapt from the URL rather than living in the pages.

import { Suspense, useState, useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import useSWR, { SWRConfig } from "swr";
import { AnimatePresence, motion } from "motion/react";

// One spring for every panel/push animation so they move as a single surface.
// High damping = fast, organic settle, no bounce, nothing linear.
import { SPRING } from "./motion.js";
import dynamic from "next/dynamic";
import ProjectPicker from "./project-picker.jsx";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import AccountMenu from "./account-menu.jsx";
import ChatPanel from "../chat-panel.jsx";

import { I } from "./icons.jsx";

const TerminalPanel = dynamic(() => import("../terminal-panel.jsx"), { ssr: false });

// Hovering the button is the cheapest moment to fetch the terminal's chunks —
// xterm is the heaviest thing the cockpit lazy-loads (bundle-preload).
let buildWarmed = false;
const warmBuild = () => {
  if (buildWarmed) return;
  buildWarmed = true;
  import("../components/agent-graph.jsx");
  import("../components/oc-chat.jsx");
};

let termWarmed = false;
const warmTerminal = () => {
  if (termWarmed) return;
  termWarmed = true;
  import("../terminal-panel.jsx");
  import("@xterm/xterm");
  import("@xterm/addon-fit");
};

const fetcher = (url) => fetch(url).then((r) => r.json());
const DEFAULT_PERIOD = "12h";

// The environment preference lives in localStorage under the key the Runs page
// writes (see app/runs/page.jsx). Read defensively: this runs on the server
// during SSR, where there is no storage.
const ENV_KEY = "eve-cockpit:env2";
const ENV_DEFAULT = "local,preview,production";
function readEnvPref() {
  if (typeof window === "undefined") return ENV_DEFAULT;
  try { return localStorage.getItem(ENV_KEY) || ENV_DEFAULT; } catch { return ENV_DEFAULT; }
}

// Icon-only controls need a real tooltip: at narrow widths the label IS the
// tooltip, and the native title is both slow and unstyled.
function Tip({ label, children }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function TopNav({ panel, setPanel, liveProject, termProject }) {
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
  useEffect(() => { setEnvPref(readEnvPref()); }, [pathname, q]);
  const environment = q.get("environment") ?? envPref;
  const period = q.get("period") ?? DEFAULT_PERIOD;
  const project = q.get("project") ?? "";

  const isDetail = pathname.startsWith("/run/");
  const isHome = pathname === "/";
  const isBuild = pathname === "/build";
  const fromBuild = q.get("from") === "build";
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
  const pickProject = (p) =>
    router.push(
      isBuild
        ? `/build?project=${encodeURIComponent(p.name)}&environment=${environment}&period=${period}`
        : listHref({ project: p.name }),
    );

  return (
    <>
      <div className="topbar">
        <TooltipProvider delay={300}>
        <AnimatePresence initial={false}>
          {!isHome && (
            <motion.div
              key="back"
              initial={{ width: 0, opacity: 0, marginRight: -10 }}
              animate={{ width: 32, opacity: 1, marginRight: 0 }}
              exit={{ width: 0, opacity: 0, marginRight: -10 }}
              transition={SPRING}
              style={{ overflow: "hidden", flexShrink: 0 }}
            >
              <Tip label={isDetail ? "Back to Agent Runs" : fromBuild ? "Back to Build" : "Back to Agents"}>
                <Link
                  className="backbtn"
                  href={isDetail ? listHref() : fromBuild ? `/build?project=${encodeURIComponent(project)}&environment=${environment}&period=${period}` : "/"}
                >{I.back}</Link>
              </Tip>
            </motion.div>
          )}
        </AnimatePresence>
        <AccountMenu />
        <ProjectPicker value={project} onChange={pickProject} />
        {isBuild && project && (
          <Tip label={`Agent runs for ${project}`}>
            <Link className="chatbtn" href={listHref({ from: "build" })}>
              {I.clockDashed} <span className="btn-label">Runs</span>
            </Link>
          </Tip>
        )}
        {!isHome && termProject && !isBuild && (
          <Tip label={`Build ${termProject.name} — generate tools with AI Gateway`}>
            <Link
              className="chatbtn"
              onMouseEnter={warmBuild}
              onFocus={warmBuild}
              href={`/build?project=${encodeURIComponent(termProject.name)}&environment=${environment}&period=${period}`}
            >
              {I.bolt} <span className="btn-label">Build</span>
            </Link>
          </Tip>
        )}
        <div className="spacer" />
        <div className="crumbstack">
          {/* layout="position" animates only where the title sits, never its
              box — so the run-id subtitle still pushes it up smoothly, while
              swapping "Agent Runs" for "Build" no longer squeezes the width. */}
          <motion.div layout="position" transition={SPRING} className="crumb-title">
            {isDetail ? <Link href={listHref()}>Agent Runs</Link> : <span>{isHome ? "Agents" : isBuild ? "Build" : "Agent Runs"}</span>}
          </motion.div>
          {/* popLayout pulls the exiting subtitle out of flow immediately, so
              the title measures its new position on that same render and
              animates down. Plain exit unmounts only AFTER its animation, and
              the title had no render left to animate with — it jumped. */}
          <AnimatePresence mode="popLayout">
            {isDetail && (
              <motion.div
                layout="position"
                className="crumb-sub"
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 5 }}
                transition={SPRING}
              >
                <span className="mono">{runId?.replace(/^wrun_/, "")}</span>
                <button className="copybtn" title="Copy run id" onClick={() => navigator.clipboard?.writeText(runId ?? "")}>{I.copy}</button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        {!isHome && liveProject && (
          <Tip label={`Chat with ${liveProject.name} on :${liveProject.localPort}`}>
            <button className="chatbtn" data-on={panel === "chat" ? "1" : "0"} onClick={() => setPanel((p) => (p === "chat" ? null : "chat"))}>
              {I.message} <span className="btn-label">Chat</span>
            </button>
          </Tip>
        )}
        {!isHome && termProject && (
          <Tip label={`Open a terminal running eve dev for ${termProject.name}`}>
            <button className="chatbtn" data-on={panel === "terminal" ? "1" : "0"} onMouseEnter={warmTerminal} onFocus={warmTerminal} onClick={() => setPanel((p) => (p === "terminal" ? null : "terminal"))}>
              {I.terminal} <span className="btn-label">Terminal</span>
            </button>
          </Tip>
        )}
        {isDetail && <span className="badge-env">{environment}</span>}
        </TooltipProvider>
      </div>

    </>
  );
}

function ShellInner({ children }) {
  const q = useSearchParams();
  const router = useRouter();
  const project = q.get("project") ?? "";

  // One companion-panel slot: chat OR terminal, never both.
  const [panel, setPanel] = useState(null);
  const [chatKey, setChatKey] = useState(0);
  const [chatSeed, setChatSeed] = useState(null);
  // Terminal sidebar width lives here so the whole frame can shrink for it —
  // the terminal PUSHES content instead of overlapping it.
  const [termWidth, setTermWidth] = useState(380);
  const [termHeight, setTermHeight] = useState(340);
  const [termDock, setTermDock] = useState("right");
  const [resizing, setResizing] = useState(false);
  // Cap: never more than 50% of the viewport, unless the screen is wide enough
  // to leave >=700px of content. Re-clamped on window resize so a width saved on
  // a big display can't swallow a laptop screen.
  const clampW = (w) =>
    Math.min(Math.max(w, 380), Math.max(window.innerWidth * 0.5, window.innerWidth - 700));
  const clampH = (h) => Math.min(Math.max(h, 200), window.innerHeight * 0.6);
  useEffect(() => {
    const w = Number(sessionStorage.getItem("termWidth"));
    if (w) setTermWidth(clampW(w));
    const h = Number(sessionStorage.getItem("termHeight"));
    if (h) setTermHeight(clampH(h));
    const d = sessionStorage.getItem("termDock");
    if (d === "bottom" || d === "right") setTermDock(d);
    const onResize = () => { setTermWidth((c) => clampW(c)); setTermHeight((c) => clampH(c)); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const setDock = (d) => { setTermDock(d); sessionStorage.setItem("termDock", d); };


  const { data: projData } = useSWR("/api/projects", fetcher, { refreshInterval: 5000, keepPreviousData: true });
  const projects = projData?.projects ?? [];
  const liveProject = projects.find((p) => p.name === (project || undefined) && p.live)
    ?? projects.find((p) => p.live && !project);
  // The terminal follows the SELECTED project only — never another project's
  // server. With no selection yet, the live one stands in.
  const termProject = project
    ? projects.find((p) => p.name === project && p.localPath) ?? null
    : liveProject ?? null;

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

  // The chat and terminal both belong to ONE agent, so they close when there
  // is no agent in view: the Agents list has no project, and leaving a
  // terminal open over it showed a session for whichever agent you last
  // visited. Build is its own full-width workspace (chat + graph) and a docked
  // panel would compete with it, so it collapses there too.
  const pathname = usePathname();
  useEffect(() => {
    if (pathname === "/build" || !project) setPanel(null);
  }, [pathname, project]);

  const pushed = (panel === "terminal" && termProject) || (panel === "chat" && liveProject);
  return (
    <>
      <motion.div
        className="frame"
        animate={{
          paddingRight: pushed && termDock === "right" ? termWidth : 0,
          paddingBottom: pushed && termDock === "bottom" ? termHeight : 0,
        }}
        transition={resizing ? { duration: 0 } : SPRING}
      >
        <TopNav panel={panel} setPanel={setPanel} liveProject={liveProject} termProject={termProject} />
        {children}
      </motion.div>
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
          onNewChat={() => { setChatSeed(null); setChatKey((k) => k + 1); }}
          seed={chatSeed}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === "terminal" && termProject && (
        <TerminalPanel
          key={termProject.name}
          project={termProject}
          dock={termDock}
          onDock={setDock}
          size={termDock === "right" ? termWidth : termHeight}
          onSize={termDock === "right" ? setTermWidth : setTermHeight}
          clamp={termDock === "right" ? clampW : clampH}
          onResizing={setResizing}
          onClose={() => setPanel(null)}
        />
      )}
      </AnimatePresence>
    </>
  );
}

export default function Shell({ children }) {
  return (
    <SWRConfig value={{ fetcher, keepPreviousData: true, revalidateOnFocus: false }}>
      <Suspense fallback={<div className="topbar" />}>
        <ShellInner>{children}</ShellInner>
      </Suspense>
    </SWRConfig>
  );
}
