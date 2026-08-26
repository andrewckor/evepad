"use client";

// The checkout's evals, listed by eve's own runner and run through it too.
// Output stays attached to the real pty and renders through the app's shared
// read-only xterm, so colours, progress and cursor updates remain live.

import { useState } from "react";
import type React from "react";
import useSWR from "swr";
import { FolderClosed, Play, PlayFill } from "vercel-geist-icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getJson as fetcher } from "@/lib/fetch";
import type { EvalInfo } from "@/app/api/evals/route";
import XtermView from "./xterm-view";
import { ScrollFade } from "./scroll-fade";
import LoadingState from "./loading-state";

export default function EvalsPane({ project }: { project: string }) {
  const { data, error } = useSWR<{ evals: EvalInfo[]; note: string | null }>(
    `/api/evals?project=${encodeURIComponent(project)}`,
    fetcher,
  );
  const [status, setStatus] = useState<string | null>(null);
  const [runningEval, setRunningEval] = useState<string | null>(null);
  const [runRequest, setRunRequest] = useState<{
    evalId: string | null;
    key: number;
  } | null>(null);
  const [terminalHeight, setTerminalHeight] = useState<number | null>(null);
  const [terminalClosing, setTerminalClosing] = useState(false);
  const running = status === "running";
  const busy = status === "starting" || status === "stopping" || running;
  const runningAll = busy && runningEval === "all";

  const run = (evalId?: string) => {
    setTerminalClosing(false);
    setStatus("starting");
    setRunningEval(evalId ?? "all");
    setRunRequest((current) => ({ evalId: evalId ?? null, key: (current?.key ?? 0) + 1 }));
  };

  const closeTerminal = () => {
    setTerminalClosing(true);
    window.setTimeout(() => {
      setRunRequest(null);
      setStatus(null);
      setTerminalHeight(null);
      setTerminalClosing(false);
    }, 280);
  };

  const stop = async () => {
    setStatus("stopping");
    const response = await fetch("/api/term", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, variant: "eval", action: "stop" }),
    });
    if (!response.ok) setStatus("running");
  };

  const runAll = async () => {
    if (busy && runningEval !== "all") {
      setStatus("stopping");
      setRunningEval("all");
      await fetch("/api/term", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, variant: "eval", action: "stop" }),
      });
    }
    run();
  };

  const startTerminalResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const pane = event.currentTarget.closest(".evals-pane");
    const terminal = pane?.querySelector(".eval-term-wrap");
    if (!(pane instanceof HTMLElement) || !(terminal instanceof HTMLElement)) return;
    const header = pane.querySelector(".inst-head");
    if (!(header instanceof HTMLElement)) return;
    const terminalBottom = terminal.getBoundingClientRect().bottom;
    const headerGap = Number.parseFloat(getComputedStyle(header).marginBottom) || 0;
    const handleHeight = event.currentTarget.getBoundingClientRect().height;
    const maxHeight = Math.max(
      180,
      terminalBottom - header.getBoundingClientRect().bottom - headerGap - 200 - handleHeight,
    );
    const move = (next: PointerEvent) => {
      const height = Math.max(180, Math.min(maxHeight, terminalBottom - next.clientY));
      setTerminalHeight(height);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (error) return <div className="empty bad">{(error as Error).message}</div>;
  if (!data)
    return (
      <div className="inst evals-pane">
        <div className="pane-loading">
          <LoadingState label="Discovering evals" elapsed={false} />
        </div>
      </div>
    );

  return (
    <div
      className={`inst evals-pane ${runRequest ? "has-terminal" : ""} ${terminalHeight === null ? "" : "term-resized"}`}
    >
      <div className="inst-head">
        <span className="inst-file mono dim2">
          <FolderClosed /> agent/evals
        </span>
        <span className="dim2" aria-hidden="true">
          ·
        </span>
        <span className="mono dim2">
          {data.evals.length} eval{data.evals.length === 1 ? "" : "s"}
        </span>
        <span className="spacer" />
        <Button
          variant="outline"
          size="sm"
          className={`eval-run-all ${runningAll ? "busy" : ""}`}
          disabled={runningAll || !data.evals.length}
          onClick={() => void runAll()}
        >
          {runningAll ? (
            <>
              <span className="eval-run-spinner" /> Running…
            </>
          ) : (
            <>
              <Play /> Run all
            </>
          )}
        </Button>
      </div>
      <ScrollFade className="eval-top">
        {data.evals.length > 0 ? (
          <div className="eval-list">
            {data.evals.map((ev) => (
              <div key={ev.id} className="eval-row">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="eval-run"
                        aria-label={`Run ${ev.id}`}
                        disabled={busy}
                        onClick={() => run(ev.id)}
                      />
                    }
                  >
                    {runningEval === ev.id ? <span className="th-spin" /> : <PlayFill />}
                  </TooltipTrigger>
                  <TooltipContent sideOffset={8}>Run eval</TooltipContent>
                </Tooltip>
                <div className="eval-copy">
                  <span className="eval-name mono">{ev.id}</span>
                  {ev.description && <span className="dim2 eval-desc">{ev.description}</span>}
                </div>
                {(ev.tags ?? []).map((t) => (
                  <span key={t} className="eval-tag mono">
                    {t}
                  </span>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="empty">{data.note ?? "No evals found."}</div>
        )}
      </ScrollFade>
      {runRequest && (
        <div
          className={`eval-term-pane ${terminalClosing ? "closing" : ""}`}
          style={
            terminalHeight === null ? undefined : { flex: "0 0 auto", height: terminalHeight + 32 }
          }
        >
          <div
            className="eval-term-resize"
            onPointerDown={startTerminalResize}
            title="Drag to resize terminal"
          />
          <div className="eval-term-wrap">
            {busy ? (
              <Button
                variant="outline"
                size="sm"
                className="eval-stop"
                disabled={status === "stopping"}
                onClick={() => void stop()}
              >
                {status === "stopping" ? "Stopping…" : "Stop"}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="icon-xs"
                className="eval-stop eval-close"
                aria-label="Close terminal"
                onClick={closeTerminal}
              >
                ×
              </Button>
            )}
            <XtermView
              key={runRequest.key}
              project={project}
              variant="eval"
              className="eval-term"
              fontSize={11.5}
              extra={runRequest.evalId ? { evalId: runRequest.evalId } : undefined}
              autoFocus={false}
              readOnly
              transformOutput={(text) => text.replaceAll("✗", "×")}
              onStatus={(info) => {
                if (info.error) {
                  setStatus("failed");
                  setRunningEval(null);
                } else {
                  setStatus("running");
                }
              }}
              onExit={() => {
                setStatus("done");
                setRunningEval(null);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
