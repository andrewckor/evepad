"use client";

import { useState, useRef, useEffect, useMemo, use, Suspense } from "react";
import type React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import useSWR from "swr";

import { fetchJson, fetchJson as fetcher } from "@/lib/fetch";
import { toast } from "@/components/ui/toast";
import { firstPromptOf } from "@/lib/run-prompt";
import { money, kt, dur, ago as agoShared } from "@/lib/format";

// Only used to round-trip the filter back to the dashboard; keep in sync with page.jsx.
const DEFAULT_PERIOD = "12h";

// This page spells out whole days ("2 days ago") where the table abbreviates.
const ago = (t: string | Date) => agoShared(t, "long");

import { I } from "@/app/components/icons";
import { Md } from "@/app/components/md";
import type { RunDetail, Turn, ToolCall } from "@/lib/types";
import type { ReactNode } from "react";

const W = {
  link: I.wrench,
  clock: I.clock,
  dollar: I.coins,
  chevRight: I.chevRight,
  chevDown: I.chevDown,
  copy: I.copy,
  external: I.external,
};

// Minimal JSON syntax coloring in the Vercel style: strings green, literals red.
function Json({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, 2) ?? "";
  const parts = text.split(/("(?:[^"\\]|\\.)*")|(\btrue\b|\bfalse\b|\bnull\b|-?\d+\.?\d*)/g);
  return (
    <pre className="json">
      {parts.map((p, i) => {
        if (p == null) return null;
        if (p.startsWith('"')) {
          // keys end with ": — leave them default; values go green
          return (
            <span
              key={i}
              className={
                parts[i + 2]?.startsWith?.(":") || text.indexOf(p + ":") !== -1 ? "j-key" : "j-str"
              }
            >
              {p}
            </span>
          );
        }
        if (/^(true|false|null|-?\d)/.test(p))
          return (
            <span key={i} className="j-lit">
              {p}
            </span>
          );
        return <span key={i}>{p}</span>;
      })}
    </pre>
  );
}

function Section({
  title,
  right,
  children,
  defaultOpen = true,
}: {
  title: ReactNode;
  right?: ReactNode;
  children?: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="sec">
      <div className="sec-head" onClick={() => setOpen((o) => !o)}>
        <h3>{title}</h3>
        {right && <div onClick={(e) => e.stopPropagation()}>{right}</div>}
        <div className="spacer" />
        <span className={"sec-chev" + (open ? " open" : "")}>{I.chevDown}</span>
      </div>
      {open && children}
    </div>
  );
}

function Pills({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (o: string) => void;
}) {
  return (
    <span className="pills">
      {options.map((o) => (
        <button key={o} data-on={o === value ? "1" : "0"} onClick={() => onChange(o)}>
          {o}
        </button>
      ))}
    </span>
  );
}

// Shape-matched skeleton: same layout as the loaded page, so nothing jumps —
// the real tabsrow (spacing and border included) with a switch-sized block,
// and the same centered 700px column the transcript uses.
function DetailSkeleton() {
  return (
    <div className="detail">
      <div className="transcript">
        <div className="tabsrow">
          <div className="sk" style={{ width: 148, height: 30 }} />
        </div>
        <div className="transcript-inner">
          <div className="sk bubble" />
          <div className="sk turn" />
          <div className="sk turn" style={{ opacity: 0.6 }} />
        </div>
      </div>
      <div className="side">
        {[90, 70, 80, 60, 75, 65].map((w, i) => (
          <div key={i} className="sk line" style={{ width: `${w}%`, marginBottom: 12 }} />
        ))}
        <div className="sk turn" style={{ marginTop: 22 }} />
      </div>
    </div>
  );
}

// One tool call rendered Vercel-style inside the Timeline: summary row with a
// waterfall segment on a shared time axis (the turn's window), so calls
// CASCADE left-to-right in execution order, then Input/Output JSON blocks.
// Collapsed by default like Vercel's, with a gray inline preview of the input
// args after the tool name; click to expand the full Input/Output JSON.
function TimelineCall({ call, t0, span }: { call: ToolCall; t0: number; span: number }) {
  const [open, setOpen] = useState(false);
  const preview = call.input
    ? JSON.stringify(call.input).replace(/[{}"]/g, "").slice(0, 14) + "…"
    : "";
  const start = call.startedAt ? Date.parse(call.startedAt) : t0;
  const left = Math.min(Math.max(((start - t0) / span) * 100, 0), 98);
  const width = Math.min(((call.durationMs ?? 0) / span) * 100, 100 - left);
  return (
    <div className="tlitem">
      <div className="tl" onClick={() => setOpen((o) => !o)} style={{ cursor: "pointer" }}>
        <span className={call.status === "completed" ? "ok" : "warn"}>✓</span>
        <span className="nm">
          {call.toolName} <span className="dim2">{preview}</span>
        </span>
        <span className="bar">
          <b />
          <i style={{ left: `${left}%`, width: `${width}%` }} />
        </span>
        <span className="ms">{dur(call.durationMs)}</span>
      </div>
      {open && (
        <div className="tlio">
          <div className="io-label">Input</div>
          <Json value={call.input} />
          {call.output != null && (
            <>
              <div className="io-label">Output</div>
              <Json value={call.output} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Detail({ runId }: { runId: string }) {
  const router = useRouter();
  const q = useSearchParams();
  const environment = q.get("environment") ?? "local";
  const period = q.get("period") ?? DEFAULT_PERIOD;
  const project = q.get("project") ?? "";
  const selectedTurnId = q.get("selectedTurnId");
  const [sideOpen, setSideOpen] = useState(true);
  const [sideW, setSideW] = useState(420);
  const [resizing, setResizing] = useState(false);
  const detailRef = useRef<HTMLDivElement | null>(null);
  // Drag from the panel's left edge; clamped so neither side can be squeezed out.
  const startSideDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    // Without this the drag paints a text selection across the panel.
    document.body.style.userSelect = "none";
    setResizing(true);
    // Against the grid's own box, not the window: with the CLI docked the
    // frame is padded right, and innerWidth overshoots by exactly that much.
    const box = detailRef.current?.getBoundingClientRect();
    const right = box?.right ?? window.innerWidth;
    const full = box?.width ?? window.innerWidth;
    const move = (ev: PointerEvent) =>
      setSideW(Math.min(Math.max(right - ev.clientX, 320), full * 0.8));
    const up = () => {
      document.body.style.userSelect = "";
      setResizing(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Carry every filter back, or returning from a run silently resets them.
  const backHref = `/?environment=${environment}&period=${period}&project=${encodeURIComponent(project)}`;

  const tab = q.get("tab") ?? "turns";
  const setTab = (t: string) => {
    const next = new URLSearchParams(q.toString());
    next.set("tab", t);
    router.replace(`/run/${runId}?${next.toString()}`, { scroll: false });
  };
  const [inputView, setInputView] = useState("Markdown");
  const [tlView, setTlView] = useState("Markdown");
  const isLocal = environment === "local";

  const detailKey = `/api/run/${encodeURIComponent(runId)}?environment=${environment}&project=${encodeURIComponent(project)}`;
  const [tailing, setTailing] = useState(false);
  const tailingRef = useRef(false);
  tailingRef.current = tailing;

  const {
    data: run,
    isLoading,
    error,
    mutate,
  } = useSWR<RunDetail>(detailKey, fetcher, {
    // Hybrid live model: snapshot on land, then the stream notifier below
    // nudges a fresh refetch the moment a new chunk arrives. Polling stays as
    // the fallback — fast when there is no tail, slow heartbeat when there is.
    refreshInterval: (latest?: RunDetail) => {
      const st = latest?.session?.status;
      if (st === "completed" || st === "failed") return 0;
      if (tailingRef.current) return 30_000; // tail is live — heartbeat only
      return isLocal ? 2000 : 5000;
    },
    revalidateOnFocus: true,
    keepPreviousData: true,
  });

  // cancel/reset go straight to the local eve server (the run IS the
  // session); a refetch shortly after picks up the status change.
  const [resetting, setResetting] = useState(false);
  const runAct = (action: "cancel" | "reset") => {
    if (action === "reset") setResetting(true);
    return fetch("/api/chat/act", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, sessionId: runId, action }),
    })
      .catch(() => {})
      .finally(() =>
        setTimeout(() => {
          mutate().finally(() => setResetting(false));
        }, 800),
      );
  };

  // A failed run can't be retried in place — the workflow is over — so a
  // re-run is a new session seeded with this one's first message.
  const firstPrompt = useMemo(() => firstPromptOf(run?.turns ?? []), [run]);
  const [rerunning, setRerunning] = useState(false);
  const rerunFailed = async () => {
    if (!firstPrompt) return;
    setRerunning(true);
    try {
      const r = await fetchJson<{ sessionId: string | null }>("/api/chat/act", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, action: "rerun", message: firstPrompt }),
      });
      toast.add({
        title: "Re-running from this prompt",
        description: r.sessionId ? "A new session started." : undefined,
        actionProps: r.sessionId
          ? {
              children: "View run",
              onClick: () =>
                router.push(
                  `/run/${r.sessionId}?environment=local&project=${encodeURIComponent(project)}`,
                ),
            }
          : undefined,
      });
    } catch (e) {
      toast.add({
        title: "Could not re-run",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setRerunning(false);
    }
  };

  // Subscribe to the run's user stream (production/preview): each new chunk
  // nudges one fresh snapshot refetch, debounced so bursts coalesce.
  const open =
    run?.session?.status && run.session.status !== "completed" && run.session.status !== "failed";
  // A turn is in flight when the run is open and the event log's tail isn't a
  // terminal event. endedAt alone lies: a CANCELLED turn never receives one.
  const lastTurn = run?.turns?.[run.turns.length - 1];
  const lastEvent = run?.events?.[run.events.length - 1]?.type ?? "";
  const settled = ["turn.completed", "turn.cancelled", "session.waiting", "session.idle"];
  const streaming = Boolean(open && lastTurn && !lastTurn.endedAt && !settled.includes(lastEvent));
  useEffect(() => {
    if (isLocal || !open) return;
    let disposed = false;
    let abort: AbortController | undefined;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const nudge = () => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        fetch(`${detailKey}&fresh=1`)
          .then((r) => r.json())
          .then((d) => mutate(d, { revalidate: false }))
          .catch(() => {});
      }, 300);
    };
    (async () => {
      while (!disposed) {
        try {
          abort = new AbortController();
          const res = await fetch(
            `/api/run/${encodeURIComponent(runId)}/stream?environment=${environment}&project=${encodeURIComponent(project)}`,
            { signal: abort.signal },
          );
          if (!res.ok) {
            setTailing(false);
            return;
          } // local/terminal/unsupported — polling covers it
          setTailing(true);
          const reader = res.body!.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done || disposed) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
              let f: { type?: string };
              try {
                f = JSON.parse(line);
              } catch {
                continue;
              }
              if (f.type === "chunk") nudge();
              if (f.type === "done") {
                setTailing(false);
                nudge();
                return;
              }
            }
          }
        } catch {}
        setTailing(false);
        if (!disposed) await new Promise((r) => setTimeout(r, 3000));
      }
    })();
    return () => {
      disposed = true;
      if (debounce) clearTimeout(debounce);
      abort?.abort();
      setTailing(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, environment, project, isLocal, open]);

  if (error) {
    return (
      <div className="empty">
        {error.message}
        <div style={{ marginTop: 14 }}>
          <Link className="mono" href={backHref}>
            ← back to Agent Runs
          </Link>
        </div>
      </div>
    );
  }
  if (isLoading && !run) return <DetailSkeleton />;
  if (!run) return <div className="empty">Run not found.</div>;

  const a = run.session.attributes ?? {};
  const turns = run.turns ?? [];
  const selected: Turn | null = turns.find((t) => t.turnId === selectedTurnId) ?? turns[0] ?? null;

  // Clicking the turn you're already on closes the panel; clicking another
  // one selects it and reopens.
  const selectTurn = (id: string) => {
    if (id === selected?.turnId) {
      setSideOpen((o) => !o);
      return;
    }
    setSideOpen(true);
    const next = new URLSearchParams(q.toString());
    next.set("selectedTurnId", id);
    router.replace(`/run/${runId}?${next.toString()}`);
  };

  // Usage tags live on the child turn run; fall back to summing the stream steps.
  const turnRun = run.childRuns.find((c) => c.attributes["$eve.type"] === "turn");
  const ta = turnRun?.attributes ?? {};
  const stepUsage = (selected?.steps ?? []).reduce(
    (acc, s) => ({
      cost: acc.cost + (s.usage?.costUsd ?? 0),
      input: acc.input + (s.usage?.inputTokens ?? 0),
      output: acc.output + (s.usage?.outputTokens ?? 0),
      cacheRead: acc.cacheRead + (s.usage?.cacheReadTokens ?? 0),
      cacheWrite: acc.cacheWrite + (s.usage?.cacheWriteTokens ?? 0),
    }),
    { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );

  const calls = (selected?.steps ?? []).flatMap((s) => s.calls);
  // Shared axis for the waterfall: the earliest call starts the window, the
  // latest end closes it.
  const callT0 = Math.min(...calls.map((c) => (c.startedAt ? Date.parse(c.startedAt) : Infinity)));
  const callEnd = Math.max(
    ...calls.map((c) =>
      c.endedAt
        ? Date.parse(c.endedAt)
        : (c.startedAt ? Date.parse(c.startedAt) : 0) + (c.durationMs ?? 0),
    ),
    callT0 + 1,
  );
  const callSpan = Number.isFinite(callT0) ? callEnd - callT0 : 1;
  const selInput = selected?.messages.find((m) => m.type === "message.received")?.text ?? null;
  const selFinal = selected
    ? [...selected.messages].reverse().find((m) => m.type === "message.completed")?.text
    : null;

  const kvRows: Array<[string, ReactNode]> = [
    // Vercel shows these as relative times.
    ["Start Time", ago(selected?.startedAt ?? run.session.createdAt)],
    ["End Time", selected?.endedAt ? ago(selected.endedAt) : "—"],
    ["Duration", dur(selected?.durationMs)],
    [
      "Workflow Run",
      <span key="w" className="mono">
        {run.session.runId.replace(/^wrun_/, "").slice(0, 14)}…
      </span>,
    ],
    ["Model", String(ta["$eve.model"] ?? "—")],
    ["Cost", money(ta["$eve.cost_usd"] ?? stepUsage.cost)],
    ["Input Tokens", kt(ta["$eve.input_tokens"] ?? stepUsage.input)],
    ["Cache Read Tokens", kt(ta["$eve.cache_read_tokens"] ?? stepUsage.cacheRead)],
    ["Cache Write Tokens", kt(ta["$eve.cache_write_tokens"] ?? stepUsage.cacheWrite)],
    ["Output Tokens", kt(ta["$eve.output_tokens"] ?? stepUsage.output)],
  ];

  return (
    <>
      <div
        ref={detailRef}
        className="detail"
        data-side={sideOpen ? "1" : "0"}
        data-resizing={resizing ? "1" : "0"}
        style={sideOpen ? { gridTemplateColumns: `1fr ${sideW}px` } : undefined}
      >
        <div className="transcript">
          <div className="tabsrow">
            <div className="seg">
              <button
                className="seg-tab"
                data-on={tab === "turns" ? "1" : "0"}
                onClick={() => setTab("turns")}
              >
                Turns
              </button>
              <button
                className="seg-tab"
                data-on={tab === "metadata" ? "1" : "0"}
                onClick={() => setTab("metadata")}
              >
                Metadata
              </button>
            </div>
            <div className="spacer" />
            {isLocal && run.session.status === "failed" && firstPrompt && (
              <button
                className="runctl"
                title="Start a new session with this run's prompt"
                disabled={rerunning}
                onClick={rerunFailed}
              >
                {rerunning ? "Starting…" : "Re-run"}
              </button>
            )}
            {isLocal && open && (
              <button
                className="runctl"
                title="End this run's workflow"
                disabled={resetting}
                onClick={() => runAct("reset")}
              >
                {resetting ? "Resetting…" : "Reset run"}
              </button>
            )}
          </div>
          <div className="transcript-inner">
            {run.note && <div className="note">{run.note}</div>}

            {tab === "metadata" ? (
              <>
                {/* Vercel's run metadata card, minus Deployment (local runs
                    have none): Model, Trigger, Duration, Status, Cost. */}
                <div className="metacard">
                  {(
                    [
                      [
                        "Model",
                        String(
                          run.childRuns.find((c) => c.attributes["$eve.model"])?.attributes[
                            "$eve.model"
                          ] ?? "—",
                        ),
                      ],
                      [
                        "Trigger",
                        String(a["$eve.trigger"] ?? "—").replace(/^./, (c) => c.toUpperCase()),
                      ],
                      [
                        "Duration",
                        (() => {
                          const lastAt = run.events[run.events.length - 1]?.at;
                          return lastAt
                            ? dur(Date.parse(lastAt) - Date.parse(String(run.session.createdAt)))
                            : "—";
                        })(),
                      ],
                      ["Status", String(run.session.status ?? "—")],
                      [
                        "Cost",
                        money(
                          run.turns.reduce(
                            (n, t) =>
                              n + t.steps.reduce((m, st) => m + (st.usage?.costUsd ?? 0), 0),
                            0,
                          ),
                        ),
                      ],
                    ] as Array<[string, string]>
                  ).map(([k, v]) => (
                    <div className="metarow" key={k}>
                      <span>{k}</span>
                      <span>{v}</span>
                    </div>
                  ))}
                </div>
                <div className="sec">
                  <h3>Session attributes</h3>
                  <Json value={a} />
                </div>
                {run.childRuns.map((c) => (
                  <div className="sec" key={c.runId}>
                    <h3>{c.workflowName}</h3>
                    <Json value={c.attributes} />
                  </div>
                ))}
              </>
            ) : (
              <>
                {turns.map((t) => {
                  const tc = t.steps.flatMap((s) => s.calls).length;
                  const cost = t.steps.reduce((n, s) => n + (s.usage?.costUsd ?? 0), 0);
                  const userMsg = t.messages.find((m) => m.type === "message.received")?.text;
                  const final = [...t.messages]
                    .reverse()
                    .find((m) => m.type === "message.completed")?.text;
                  return (
                    <div key={t.turnId}>
                      {userMsg && (
                        <div className="bubble">
                          {userMsg}
                          {/^https?:\/\/\S+$/.test(userMsg.trim()) && (
                            <a
                              href={userMsg.trim()}
                              target="_blank"
                              rel="noreferrer"
                              className="bubble-ext"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {I.external ?? "↗"}
                            </a>
                          )}
                        </div>
                      )}
                      <div
                        className={
                          "turncard" + (sideOpen && t.turnId === selected?.turnId ? " sel" : "")
                        }
                        onClick={() => selectTurn(t.turnId)}
                      >
                        <div className="turnhead">
                          <span className="stat">
                            {W.link} {tc}
                          </span>
                          <span className="stat">
                            {I.clock} {dur(t.durationMs)}
                          </span>
                          <span className="stat">
                            {W.dollar} {money(cost)}
                          </span>
                          <div className="spacer" />
                          <span className="dim2">{I.chevRight}</span>
                        </div>
                        {final && (
                          <div className="turnbody">
                            <Md className="chat-md prose-md">{final}</Md>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {!turns.length && !run.note && <div className="empty">No turns recorded.</div>}
                {!open && turns.length > 0 && (
                  <div className="run-ended">This workflow has ended.</div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="side">
          <div
            className="side-resize"
            data-on={resizing ? "1" : "0"}
            onPointerDown={startSideDrag}
            title="Drag to resize"
          />
          <div className="side-title">
            <span className="mono">{selected?.turnId ?? "session"}</span>
            <div className="spacer" />
            {/* Same rule as the chat's square stop: only while a turn is
                actually in flight. */}
            {isLocal && streaming && (
              <button
                className="runctl"
                title="Cancel the in-flight turn"
                onClick={() => runAct("cancel")}
              >
                <span className="oc-stopsq" /> Cancel
              </button>
            )}
          </div>

          <Section title="Metadata">
            {kvRows.map(([k, v]) => (
              <div className="kv" key={k}>
                <span className="k">{k}</span>
                <span className="v">{v}</span>
              </div>
            ))}
          </Section>

          {selInput != null && (
            <Section
              title="Input"
              right={
                <Pills options={["Markdown", "Raw"]} value={inputView} onChange={setInputView} />
              }
            >
              {inputView === "Raw" ? (
                <Json value={selInput} />
              ) : (
                <Md className="chat-md prose-md">{selInput}</Md>
              )}
            </Section>
          )}

          {selected && (
            <Section
              title="Timeline"
              right={<Pills options={["Markdown", "Raw"]} value={tlView} onChange={setTlView} />}
            >
              {tlView === "Raw" ? (
                <Json value={selected.steps} />
              ) : (
                <>
                  {calls.map((c) => (
                    <TimelineCall
                      key={c.callId}
                      call={c}
                      t0={Number.isFinite(callT0) ? callT0 : 0}
                      span={callSpan}
                    />
                  ))}
                  {!calls.length && <div className="dim2 mono">no tool calls</div>}
                  {selFinal && (
                    <div style={{ marginTop: 10 }}>
                      <Md className="chat-md prose-md">{selFinal}</Md>
                    </div>
                  )}
                </>
              )}
            </Section>
          )}

          {selected && (
            <Section title="Steps" defaultOpen={false}>
              {selected.steps.map((s) => (
                <div className="tool" key={s.stepIndex}>
                  <div className="kv">
                    <span className="k">step {s.stepIndex}</span>
                    <span className="v">{s.finishReason ?? "—"}</span>
                  </div>
                  {s.usage && (
                    <div className="dim2 mono">
                      {money(s.usage.costUsd)} · {s.usage.inputTokens} in / {s.usage.outputTokens}{" "}
                      out
                    </div>
                  )}
                  {s.generationId && <div className="dim2 mono">{s.generationId}</div>}
                </div>
              ))}
            </Section>
          )}
        </div>
      </div>
    </>
  );
}

export default function Page({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  return (
    <Suspense fallback={<div className="empty">Loading…</div>}>
      <Detail runId={runId} />
    </Suspense>
  );
}
