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
export const SPRING = { type: "spring", stiffness: 480, damping: 44 };
import dynamic from "next/dynamic";
import ProjectPicker from "./project-picker.jsx";
import ChatPanel from "../chat-panel.jsx";

import { I } from "./icons.jsx";

const TerminalPanel = dynamic(() => import("../terminal-panel.jsx"), { ssr: false });

const fetcher = (url) => fetch(url).then((r) => r.json());
const DEFAULT_PERIOD = "12h";

function TopNav({ panel, setPanel, liveProject, termProject }) {
  const pathname = usePathname();
  const router = useRouter();
  const q = useSearchParams();

  const environment = q.get("environment") ?? "local";
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

  // Switching projects always lands on that project's run list; a run id only
  // belongs to one project, so staying on the detail page would be a lie.
  // The environment selection is a GLOBAL setting — never rewritten here; the
  // data layer degrades gracefully when an env has nothing for the project.
  const pickProject = (p) => router.push(listHref({ project: p.name }));

  return (
    <>
      <div className="topbar">
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
              <Link
                className="backbtn"
                href={isDetail ? listHref() : fromBuild ? `/build?project=${encodeURIComponent(project)}&environment=${environment}&period=${period}` : "/"}
                title={isDetail ? "Back to Agent Runs" : fromBuild ? "Back to Build" : "Back to Agents"}
              >{I.back}</Link>
            </motion.div>
          )}
        </AnimatePresence>
        <ProjectPicker value={project} onChange={pickProject} />
        {isBuild && project && (
          <Link className="chatbtn" href={listHref({ from: "build" })} title={`Agent runs for ${project}`}>
            {I.clockDashed} Runs
          </Link>
        )}
        {termProject && !isBuild && (
          <Link
            className="chatbtn"
            href={`/build?project=${encodeURIComponent(termProject.name)}&environment=${environment}&period=${period}`}
            title={`Build ${termProject.name} — generate tools with AI Gateway`}
          >
            {I.bolt} Build
          </Link>
        )}
        <div className="spacer" />
        <div className="crumbstack">
          <motion.div layout transition={SPRING} className="crumb-title">
            {isDetail ? <Link href={listHref()}>Agent Runs</Link> : <span>{isHome ? "Agents" : isBuild ? "Build" : "Agent Runs"}</span>}
          </motion.div>
          <AnimatePresence>
            {isDetail && (
              <motion.div
                layout
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
        <div className="spacer" />
        {liveProject && (
          <button className="chatbtn" data-on={panel === "chat" ? "1" : "0"} onClick={() => setPanel((p) => (p === "chat" ? null : "chat"))} title={`Chat with ${liveProject.name} on :${liveProject.localPort}`}>
            {I.message} Chat
          </button>
        )}
        {termProject && (
          <button className="chatbtn" data-on={panel === "terminal" ? "1" : "0"} onClick={() => setPanel((p) => (p === "terminal" ? null : "terminal"))} title={`Open a terminal running eve dev for ${termProject.name}`}>
            {I.terminal} Terminal
          </button>
        )}
        {isDetail && <span className="badge-env">{environment}</span>}
      </div>

    </>
  );
}

function ShellInner({ children }) {
  const q = useSearchParams();
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
