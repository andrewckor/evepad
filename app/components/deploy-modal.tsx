"use client";

// The deploy window. Same chrome as the Create-agent dialog; the CLI stream
// renders as folded text (spinners collapse, ANSI gone). Opening attaches to
// whatever deploy is out there — closing never stops or restarts one, and a
// finished run says so instead of rerunning.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Check } from "vercel-geist-icons";
import { fetchJson } from "@/lib/fetch";
import { foldLines, readDeployOutput, joinLines } from "@/lib/deploy-output";
import type { DeployTarget } from "@/lib/deploy-command";

export default function DeployModal({
  project,
  initialTarget,
  open,
  onOpenChange,
}: {
  project: string;
  initialTarget?: DeployTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const preRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    preRef.current?.scrollTo({ top: preRef.current.scrollHeight });
  }, [lines]);

  const verdict = readDeployOutput(lines);

  const attach = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(
          `/api/term/stream?project=${encodeURIComponent(project)}&variant=deploy`,
          { signal },
        );
        if (!res.ok || !res.body) return false;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (signal?.aborted) return true;
          const text = dec.decode(value, { stream: true });
          if (text) setLines((ls) => foldLines(ls, text));
        }
        return true;
      } catch {
        return false; // dialog closed mid-read — the pty keeps running
      }
    },
    [project],
  );

  const start = useCallback(
    async (variant: DeployTarget) => {
      setLines([]);
      setStarted(true);
      try {
        await fetchJson("/api/term", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project, variant, action: "start", cols: 120, rows: 30 }),
        });
      } catch (e) {
        setLines([`Could not start the deploy: ${e instanceof Error ? e.message : e}`]);
        return;
      }
      await attach();
    },
    [project, attach],
  );

  // On open: an explicit target starts immediately, once. Otherwise probe —
  // a running or finished deploy replays its log; nothing out there means
  // idle, never an automatic rerun.
  const kicked = useRef(false);
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (!open) {
      kicked.current = false;
      setStarted(false);
      setLines([]);
      return;
    }
    if (kicked.current) return;
    kicked.current = true;
    const ctrl = new AbortController();
    let cancelled = false;
    (async () => {
      if (initialTarget) {
        await start(initialTarget);
        return;
      }
      const attached = await attach(ctrl.signal);
      if (!cancelled && !attached) setLines([]);
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialTarget]);

  const running = verdict.state === "running" && started;

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

          {verdict.state === "success" && (
            <p className="deploy-ok">
              <Check /> Deployed
              {verdict.url && (
                <>
                  {" — "}
                  <a href={verdict.url} target="_blank" rel="noreferrer">
                    {verdict.url.replace(/^https?:\/\//, "")}
                  </a>
                </>
              )}
            </p>
          )}
          {verdict.state === "failed" && (
            <p className="deploy-fail">Deployment failed — the CLI output below says why.</p>
          )}

          {(started || lines.length > 0) && (
            <div className="na-term">
              <pre ref={preRef} className="deploy-out mono">
                {joinLines(lines)}
              </pre>
            </div>
          )}

          {!running && (
            <div className="set-footer">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {lines.length ? "Close" : "Cancel"}
              </Button>
              <Button variant="outline" onClick={() => start("deploy-preview")}>
                Deploy to Preview
              </Button>
              <Button onClick={() => start("deploy")}>Deploy to Production</Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
