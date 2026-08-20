"use client";

// Embedded terminal drawer running the real eve dev TUI — the same one you get
// in a normal shell, so chatting with the agent, watching logs, and its slash
// commands all work. xterm.js renders; a pty on evepad server hosts.

import { useState } from "react";
import type React from "react";
import { SidebarRight, ChevronRight, ChevronDown } from "vercel-geist-icons";
import { m as M } from "motion/react";
import { SPRING } from "./components/motion";
import XtermView from "./components/xterm-view";

import type { Project, Dock } from "@/lib/types";

export default function TerminalPanel({
  project,
  dock,
  onDock,
  size,
  onSize,
  clamp,
  onResizing,
  onClose,
}: {
  project: Project;
  dock: Dock;
  onDock: (d: Dock) => void;
  size: number;
  onSize: (v: number) => void;
  clamp: (v: number) => number;
  onResizing?: (v: boolean) => void;
  onClose: () => void;
}) {
  // The old flat "starting…" lied for the common case — an already-running
  // server is an ATTACH. Seed from what we already know about the project.
  const [status, setStatus] = useState(() =>
    project.live && project.localPort ? `attaching to :${project.localPort}…` : "starting server…",
  );
  // Geometry is owned by the shell (it pads the frame so the panel pushes content).
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    onResizing?.(true);
    const move = (ev: PointerEvent) => {
      const raw =
        dock === "right" ? window.innerWidth - ev.clientX : window.innerHeight - ev.clientY;
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

  const off = dock === "right" ? { x: "100%" } : { y: "100%" };
  return (
    <M.aside
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
        <b className="term-title">{project.name}</b>
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
      <XtermView
        project={project.name}
        onStatus={(info) =>
          setStatus(
            info.error ??
              (info.mode === "attach" ? `attached to :${info.port}` : `serving on :${info.port}`),
          )
        }
      />
    </M.aside>
  );
}
