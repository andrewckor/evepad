"use client";

// THINKING — the agent's trace, cloned from beautifului.dev.
//
// One header per run of trace parts ("Thinking" while it works, "Ran 3 tools"
// after) over an indented, rail-lined list of rows. Replaces the old shape,
// where every reasoning line and every tool call was its own free-floating
// row at its own indent — a transcript that read as debris rather than as one
// thing the agent did.
//
// Rows stay interactive after the run settles: reasoning expands to the full
// text, a finished tool expands to its output.

import { useState } from "react";
import { Sparkles, ChevronDownSmall, Terminal, Pencil, MagnifyingGlass, Globe, Wrench, CrossCircle } from "vercel-geist-icons";
import { PixelGrid } from "./loading-state.jsx";

// Geist icon per opencode tool — nearest concept, never invented (AGENTS.md).
const TOOL_ICONS = {
  bash: <Terminal />, edit: <Pencil />, write: <Pencil />, patch: <Pencil />,
  read: <MagnifyingGlass />, glob: <MagnifyingGlass />, grep: <MagnifyingGlass />,
  list: <MagnifyingGlass />, webfetch: <Globe />,
};

const Check = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

function toolLabel(part) {
  const input = part.state?.input ?? {};
  const file = input.filePath ?? input.path;
  if (file) return String(file).split("/").slice(-2).join("/");
  if (input.command) return String(input.command);
  if (input.pattern) return String(input.pattern);
  if (input.url) return String(input.url);
  return "";
}

const secs = (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

// "Thought for 4.2s" once it settles; while it runs, whichever thing it is
// actually doing. Naming the current activity beats a generic spinner —
// that's the whole point of showing a trace.
function headline(parts, busy) {
  const tools = parts.filter((p) => p.type === "tool");
  const running = tools.find((p) => ["running", "pending"].includes(p.state?.status));
  if (busy) {
    if (running) return running.tool === "bash" ? "Running a command" : `Running ${running.tool}`;
    return "Thinking";
  }
  if (tools.length) return `Ran ${tools.length} tool${tools.length === 1 ? "" : "s"}`;
  const ms = parts.reduce((n, p) => n + (p.time?.end && p.time?.start ? p.time.end - p.time.start : 0), 0);
  return ms ? `Thought for ${secs(ms)}` : "Thought";
}

export default function Thinking({ parts, busy }) {
  // Expanded while working, settles closed — with a manual override that
  // survives the transition, so opening it mid-run doesn't snap shut.
  const [manual, setManual] = useState(null);
  const [openRows, setOpenRows] = useState(() => new Set());
  const expanded = manual ?? busy;
  const toggleRow = (id) => setOpenRows((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  return (
    <div className="th">
      <button
        type="button"
        className="th-head"
        aria-expanded={expanded}
        onClick={() => setManual((m) => !(m ?? busy))}
      >
        <span className={"th-spark" + (busy ? " on" : "")}><Sparkles /></span>
        <span className={busy ? "th-title shimmer-text" : "th-title"}>{headline(parts, busy)}</span>
        <span className={"th-chev" + (expanded ? " open" : "")}><ChevronDownSmall /></span>
      </button>

      <div className="th-wrap" data-open={expanded ? "1" : "0"}>
        <div className="th-clip">
          <div className="th-trace">
            {parts.map((p) => {
              const open = openRows.has(p.id);
              if (p.type === "reasoning") {
                if (!p.text?.trim()) return null;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={"th-row th-reason" + (open ? " open" : "")}
                    onClick={() => toggleRow(p.id)}
                  >
                    <span className="th-text">{p.text}</span>
                  </button>
                );
              }
              const st = p.state?.status;
              const label = toolLabel(p);
              const expandable = st === "completed" && p.state?.output;
              return (
                <div key={p.id} className="th-item">
                  <button
                    type="button"
                    className={"th-row" + (expandable ? "" : " static") + (open ? " sel" : "")}
                    onClick={expandable ? () => toggleRow(p.id) : undefined}
                  >
                    <span className={"th-ic s-" + (st ?? "pending")}>
                      {st === "error" ? <CrossCircle />
                        : ["pending", "running"].includes(st) ? <PixelGrid />
                        : (TOOL_ICONS[p.tool] ?? <Wrench />)}
                    </span>
                    <span className="th-name">{p.tool}</span>
                    {label && <span className="th-sub mono">{label}</span>}
                  </button>
                  {open && <pre className="th-out">{String(p.state.output).slice(0, 4000)}</pre>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
