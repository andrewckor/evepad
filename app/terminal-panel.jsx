"use client";

// Embedded terminal drawer running the real eve dev TUI — the same one you get
// in a normal shell, so chatting with the agent, watching logs, and its slash
// commands all work. xterm.js renders; a pty on the cockpit server hosts.

import { useEffect, useRef, useState } from "react";
import { SidebarRight, ChevronRight, ChevronDown } from "vercel-geist-icons";
import { motion } from "motion/react";
import { SPRING } from "./components/motion.js";

// Reads the live tokens so the terminal matches whatever the rest of the app
// is wearing, instead of a second copy of the palette drifting out of step.
function xtermTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, fallback) => cs.getPropertyValue(n).trim() || fallback;
  return {
    background: v("--panel", "#0a0a0a"),
    foreground: v("--fg", "#ededed"),
    cursor: v("--acc", "#0072f5"),
  };
}

export default function TerminalPanel({ project, dock, onDock, size, onSize, clamp, onResizing, onClose }) {
  const mount = useRef(null);
  // The old flat "starting…" lied for the common case — an already-running
  // server is an ATTACH. Seed from what we already know about the project.
  const [status, setStatus] = useState(() =>
    project.live && project.localPort ? `attaching to :${project.localPort}…` : "starting server…");
  // Geometry is owned by the shell (it pads the frame so the panel pushes content).
  const startDrag = (e) => {
    e.preventDefault();
    onResizing?.(true);
    const move = (ev) => {
      const raw = dock === "right" ? window.innerWidth - ev.clientX : window.innerHeight - ev.clientY;
      const v = clamp(raw);
      onSize(v);
      sessionStorage.setItem(dock === "right" ? "termWidth" : "termHeight", String(Math.round(v)));
    };
    const up = () => {
      onResizing?.(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  useEffect(() => {
    let disposed = false;
    let xterm, fit, abort;
    let themeSync;

    (async () => {
      // Fire the pty request FIRST and await it later: it used to sit behind
      // the xterm bundle, so the server didn't even hear about us until the
      // chunk had loaded (async-parallel / async-defer-await).
      const startReq = fetch("/api/term", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: project.name, action: "start" }),
      });

      // xterm touches `window` at import time — load it client-side only.
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/xterm/css/xterm.css"),
      ]);
      if (disposed) return;

      const start = await startReq;
      const info = await start.json();
      if (!start.ok) { setStatus(info.error ?? "failed to start"); return; }
      setStatus(info.mode === "attach" ? `attached to :${info.port}` : `serving on :${info.port}`);

      xterm = new Terminal({
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12.5,
        // xterm paints to a canvas, so it can't read CSS variables — the
        // theme has to be handed to it, and re-handed when it changes.
        theme: xtermTheme(),
        cursorBlink: true,
        scrollback: 4000,
      });
      themeSync = new MutationObserver(() => { xterm.options.theme = xtermTheme(); });
      themeSync.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

      fit = new FitAddon();
      xterm.loadAddon(fit);
      xterm.open(mount.current);
      fit.fit();
      xterm.focus();

      const sendResize = () =>
        fetch("/api/term", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project: project.name, action: "resize", cols: xterm.cols, rows: xterm.rows }),
        });
      sendResize();
      const ro = new ResizeObserver(() => { fit.fit(); sendResize(); });
      ro.observe(mount.current);

      xterm.onData((data) =>
        fetch("/api/term", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project: project.name, action: "input", data }),
        }),
      );

      abort = new AbortController();
      const res = await fetch(`/api/term/stream?project=${encodeURIComponent(project.name)}`, { signal: abort.signal });
      const reader = res.body.getReader();
      (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || disposed) break;
          xterm.write(value);
        }
      })().catch(() => {}); // closing the panel aborts the read — expected

      return () => ro.disconnect();
    })().catch(() => {}); // teardown aborts the stream mid-await — expected

    return () => {
      themeSync?.disconnect();
      disposed = true;
      abort?.abort();
      xterm?.dispose();
    };
  }, [project.name]);

  const off = dock === "right" ? { x: "100%" } : { y: "100%" };
  return (
    <motion.aside
      className={"termside " + dock}
      style={dock === "right" ? { width: size } : { height: size }}
      initial={off}
      animate={{ x: 0, y: 0 }}
      exit={off}
      transition={SPRING}
    >
      <div className={"term-resize " + dock} onPointerDown={startDrag} title="Drag to resize" />
      <div className="term-head">
        <span className="dot on" />
        <b>{project.name}</b>
        <span className="dim2 mono">{status}</span>
        <div className="spacer" />
        <div className="term-actions">
          <button
            className="dockbtn"
            onClick={() => onDock(dock === "right" ? "bottom" : "right")}
            title={dock === "right" ? "Dock to bottom" : "Dock to right"}
          >
            {/* The icon shows the DESTINATION: split-bottom when it will dock
                to bottom, split-right when it will dock back to the side. */}
            <SidebarRight style={dock === "right" ? { transform: "rotate(90deg)" } : undefined} />
          </button>
          {/* Close points the way the panel leaves: right when docked right,
              down when docked to the bottom. */}
          <button className="closebtn" onClick={onClose} title="Close panel">
            {dock === "right" ? <ChevronRight /> : <ChevronDown />}
          </button>
        </div>
      </div>
      <div className="term-body" ref={mount} />
    </motion.aside>
  );
}
