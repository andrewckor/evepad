"use client";

// The checkout's evals, listed by eve's own runner and run through it too —
// the pty output streams into a plain pre (ANSI stripped), so the pane costs
// no xterm and reuses the terminal server wholesale.

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Play } from "vercel-geist-icons";
import { Button } from "@/components/ui/button";
import { fetchJson, getJson as fetcher } from "@/lib/fetch";
import type { EvalInfo } from "@/app/api/evals/route";

// \x1b IS the subject: this strips ANSI colour sequences from pty bytes.
// oxlint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");

export default function EvalsPane({ project }: { project: string }) {
  const { data, error } = useSWR<{ evals: EvalInfo[]; note: string | null }>(
    `/api/evals?project=${encodeURIComponent(project)}`,
    fetcher,
  );
  const [output, setOutput] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const running = status === "running";
  const preRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (!running) return;
    let disposed = false;
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(
          `/api/term/stream?project=${encodeURIComponent(project)}&variant=eval`,
          { signal: ctrl.signal },
        );
        if (!res.ok || !res.body) throw new Error("no stream");
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done || disposed) break;
          setOutput((o) => (o ?? "") + stripAnsi(dec.decode(value, { stream: true })));
        }
        setStatus("done");
      } catch {
        if (!disposed) setStatus((s) => (s === "running" ? "stream lost" : s));
      }
    })();
    return () => {
      disposed = true;
      ctrl.abort();
    };
  }, [running, project]);

  useEffect(() => {
    preRef.current?.scrollTo({ top: preRef.current.scrollHeight });
  }, [output]);

  const run = async () => {
    setStatus("running");
    setOutput("");
    try {
      await fetchJson("/api/term", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, variant: "eval", action: "start", cols: 100, rows: 34 }),
      });
    } catch (e) {
      setStatus(null);
      setOutput(`Could not start the eval runner: ${e instanceof Error ? e.message : e}`);
    }
  };

  if (error) return <div className="empty bad">{(error as Error).message}</div>;
  if (!data) return <div className="empty">Discovering evals…</div>;

  return (
    <div className="inst">
      <div className="inst-head">
        <span className="mono dim2">
          {data.evals.length} eval{data.evals.length === 1 ? "" : "s"}
        </span>
        <span className="spacer" />
        {status && status !== "done" && <span className="dim2">{status}</span>}
        <Button variant="outline" size="sm" disabled={running || !data.evals.length} onClick={run}>
          <Play /> Run all
        </Button>
      </div>
      {data.evals.length > 0 ? (
        <div className="eval-list">
          {data.evals.map((ev) => (
            <div key={ev.id} className="eval-row">
              <span className="mono">{ev.id}</span>
              {ev.description && <span className="dim2">{ev.description}</span>}
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
      {output !== null && (
        <pre ref={preRef} className="eval-out mono">
          {output}
        </pre>
      )}
    </div>
  );
}
