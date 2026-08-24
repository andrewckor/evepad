"use client";

// The deploy window. Same chrome as the Create-agent dialog around a REAL
// terminal: the CLI's spinner, colours and links render the way they do in a
// shell instead of collapsing into folded text. Opening attaches to whatever
// deploy is out there — the pty manager hands back a running deploy rather
// than spawning a second one, and replays its scrollback, so closing and
// reopening never loses the log or restarts the run.
//
// The footer is status, not actions: the menu already chose the target, so
// the only thing left to offer is the deployment itself once it exists.

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Check, External } from "vercel-geist-icons";
import XtermView from "./xterm-view";
import LoadingState from "./loading-state";
import { foldLines, readDeployOutput } from "@/lib/deploy-output";
import type { DeployTarget } from "@/lib/deploy-command";

export default function DeployModal({
  project,
  target,
  open,
  onOpenChange,
}: {
  project: string;
  target: DeployTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // The terminal paints the bytes; this folds the same bytes into lines only
  // to READ the outcome (exit code, aliased URL) — never to display them.
  const [lines, setLines] = useState<string[]>([]);
  // No reset on close: the menu unmounts this window, so every opening starts
  // with fresh state and the terminal replays the pty's scrollback.
  const [startError, setStartError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const verdict = readDeployOutput(lines);
  const restart = () => {
    setLines([]);
    setStartError(null);
    setStarted(false);
    setAttempt((value) => value + 1);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="set-dialog">
        <div className="set-body">
          <DialogHeader>
            <DialogTitle>Deploy {project}</DialogTitle>
            <DialogDescription>
              Runs vercel deploy in this agent's checkout. Closing the window keeps it running.
            </DialogDescription>
          </DialogHeader>

          {open && (
            <XtermView
              key={attempt}
              project={project}
              variant={target}
              className="deploy-term"
              fontSize={11.5}
              autoFocus={false}
              startAction={attempt ? "restart" : "start"}
              onStatus={(info) => {
                setStartError(info.error ?? null);
                setStarted(!info.error);
              }}
              onData={(text) => setLines((ls) => foldLines(ls, text))}
            />
          )}

          <div className="set-footer deploy-footer">
            <div className="deploy-status" role="status" aria-live="polite" aria-atomic="true">
              {startError ? (
                <span className="deploy-fail">{startError}</span>
              ) : !started || verdict.state === "running" ? (
                <LoadingState label="Deploying…" elapsed={false} />
              ) : verdict.state === "success" ? (
                <span className="deploy-ok">
                  <Check aria-hidden="true" /> Deployed
                </span>
              ) : (
                <span className="deploy-fail">Deployment failed — the log above says why.</span>
              )}
            </div>
            <div className="deploy-actions">
              {(startError || (started && verdict.state !== "running")) && (
                <Button variant="outline" onClick={restart}>
                  {startError
                    ? "Retry"
                    : target === "deploy"
                      ? "Redeploy to Production"
                      : "Redeploy Preview"}
                </Button>
              )}
              {verdict.state === "success" && verdict.url && (
                <Button
                  nativeButton={false}
                  render={<a href={verdict.url} target="_blank" rel="noreferrer" />}
                >
                  Open Deployment
                  <External aria-hidden="true" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
