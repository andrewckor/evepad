"use client";

import { useState, use, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import useSWR from "swr";

// Never blindly .json() a response: a non-JSON error body throws inside the render
// and takes the whole page down with a 500 instead of showing the message.
const fetcher = async (url) => {
  const r = await fetch(url);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { error: text || r.statusText }; }
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body;
};

// Only used to round-trip the filter back to the dashboard; keep in sync with page.jsx.
const DEFAULT_PERIOD = "12h";

// Run attributes are always strings ($eve.cost_usd is "0.0011166"), so coerce.
const money = (n) => "$" + (Number(n) || 0).toFixed(4);
const kt = (n) => {
  const v = Number(n) || 0;
  return v >= 1000 ? (v / 1000).toFixed(1) + "K" : String(v);
};
const dur = (ms) => (ms == null ? "—" : ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s");
const statusClass = (s) => (s === "completed" ? "ok" : s === "failed" ? "bad" : "warn");

function Detail({ runId }) {
  const router = useRouter();
  const q = useSearchParams();
  const environment = q.get("environment") ?? "local";
  const period = q.get("period") ?? DEFAULT_PERIOD;
  const project = q.get("project") ?? "";
  const selectedTurnId = q.get("selectedTurnId");

  // Carry every filter back, or returning from a run silently resets them.
  const backHref = `/?environment=${environment}&period=${period}&project=${encodeURIComponent(project)}`;

  const [tab, setTab] = useState("turns");
  const isLocal = environment === "local";

  const { data: run, isLoading, error } = useSWR(
    `/api/run/${encodeURIComponent(runId)}?environment=${environment}&project=${encodeURIComponent(project)}`,
    fetcher,
    {
      refreshInterval: isLocal ? 2000 : 0,
      revalidateOnFocus: isLocal,
      keepPreviousData: true,
    },
  );

  if (error) {
    return (
      <div className="empty">
        {error.message}
        <div style={{ marginTop: 14 }}><Link className="mono" href={backHref}>← back to Agent Runs</Link></div>
      </div>
    );
  }
  if (isLoading && !run) return <div className="empty">Loading {environment} run…</div>;
  if (!run) return <div className="empty">Run not found.</div>;

  const a = run.session.attributes ?? {};
  const turns = run.turns ?? [];
  const selected = turns.find((t) => t.turnId === selectedTurnId) ?? turns[0] ?? null;

  const selectTurn = (id) => {
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
  const maxCall = Math.max(...calls.map((c) => c.durationMs ?? 0), 1);
  const prompt = turns[0]?.messages.find((m) => m.type === "message.received")?.text ?? a["$eve.title"];

  return (
    <>
      <div className="topbar">
        <div className="crumb">
          {/* Must be <Link>, not <a>: a plain anchor does a full page load, which
              destroys the SWR cache and makes every return a cold fetch. */}
          <Link href={backHref}>Observability</Link><span>/</span>
          <Link href={backHref}>Agent Runs</Link><span>/</span>
          <b className="mono">{run.session.runId.replace(/^wrun_/, "")}</b>
        </div>
        <span className="badge">{environment}</span>
        <div className="spacer" />
        <div className="seg">
          <button data-on={tab === "turns" ? "1" : "0"} onClick={() => setTab("turns")}>Turns</button>
          <button data-on={tab === "metadata" ? "1" : "0"} onClick={() => setTab("metadata")}>Metadata</button>
        </div>
      </div>

      <div className="detail">
        <div className="transcript">
          {run.note && <div className="note">{run.note}</div>}

          {tab === "metadata" ? (
            <>
              <div className="sec">
                <h3>Session attributes</h3>
                <pre>{JSON.stringify(a, null, 2)}</pre>
              </div>
              {run.childRuns.map((c) => (
                <div className="sec" key={c.runId}>
                  <h3>{c.workflowName}</h3>
                  <pre>{JSON.stringify(c.attributes, null, 2)}</pre>
                </div>
              ))}
            </>
          ) : (
            <>
              {prompt && <div className="bubble">{prompt}</div>}
              {turns.map((t) => {
                const tc = t.steps.flatMap((s) => s.calls).length;
                const cost = t.steps.reduce((n, s) => n + (s.usage?.costUsd ?? 0), 0);
                const final = [...t.messages].reverse().find((m) => m.type === "message.completed")?.text;
                return (
                  <div
                    key={t.turnId}
                    className={"turncard" + (t.turnId === selected?.turnId ? "" : " plain")}
                    onClick={() => selectTurn(t.turnId)}
                  >
                    <div className="turnhead">
                      <span>🔧 {tc}</span>
                      <span>⏱ {dur(t.durationMs)}</span>
                      <span>💲 {money(cost)}</span>
                      <div className="spacer" />
                      <span className="mono dim2">{t.turnId}</span>
                    </div>
                    {final && <div className="turnbody">{final}</div>}
                  </div>
                );
              })}
              {!turns.length && !run.note && <div className="empty">No turns recorded.</div>}
            </>
          )}
        </div>

        <div className="side">
          <div className="sec">
            <h3>{selected?.turnId ?? "session"}</h3>
            <div className="kv"><span className="k">Status</span><span className={"v " + statusClass(run.session.status)}>{run.session.status}</span></div>
            <div className="kv"><span className="k">Start Time</span><span className="v">{new Date(run.session.createdAt).toLocaleTimeString()}</span></div>
            <div className="kv"><span className="k">Duration</span><span className="v">{dur(selected?.durationMs)}</span></div>
            <div className="kv"><span className="k">Workflow Run</span><span className="v">{run.session.runId.replace(/^wrun_/, "").slice(0, 12)}…</span></div>
            <div className="kv"><span className="k">Model</span><span className="v">{ta["$eve.model"] ?? "—"}</span></div>
            <div className="kv"><span className="k">Cost</span><span className="v">{money(ta["$eve.cost_usd"] ?? stepUsage.cost)}</span></div>
            <div className="kv"><span className="k">Input Tokens</span><span className="v">{kt(ta["$eve.input_tokens"] ?? stepUsage.input)}</span></div>
            <div className="kv"><span className="k">Cache Read</span><span className="v">{kt(ta["$eve.cache_read_tokens"] ?? stepUsage.cacheRead)}</span></div>
            <div className="kv"><span className="k">Cache Write</span><span className="v">{kt(ta["$eve.cache_write_tokens"] ?? stepUsage.cacheWrite)}</span></div>
            <div className="kv"><span className="k">Output Tokens</span><span className="v">{kt(ta["$eve.output_tokens"] ?? stepUsage.output)}</span></div>
          </div>

          {selected && (
            <div className="sec">
              <h3>Timeline</h3>
              {calls.map((c) => (
                <div className="tl" key={c.callId}>
                  <span className={c.status === "completed" ? "ok" : "warn"}>✓</span>
                  <span className="nm">{c.toolName}</span>
                  <span className="bar">
                    <i style={{ left: 0, width: `${Math.max(((c.durationMs ?? 0) / maxCall) * 100, 4)}%` }} />
                  </span>
                  <span className="ms">{dur(c.durationMs)}</span>
                </div>
              ))}
              {!calls.length && <div className="dim2 mono">no tool calls</div>}
            </div>
          )}

          {selected && (
            <div className="sec">
              <h3>Steps</h3>
              {selected.steps.map((s) => (
                <div className="tool" key={s.stepIndex}>
                  <div className="kv">
                    <span className="k">step {s.stepIndex}</span>
                    <span className="v">{s.finishReason ?? "—"}</span>
                  </div>
                  {s.usage && (
                    <div className="dim2 mono">
                      {money(s.usage.costUsd)} · {s.usage.inputTokens} in / {s.usage.outputTokens} out
                    </div>
                  )}
                  {s.generationId && <div className="dim2 mono">{s.generationId}</div>}
                  {s.calls.map((c) => (
                    <div key={c.callId}>
                      <pre>← {JSON.stringify(c.input)}</pre>
                      {c.output != null && <pre>→ {JSON.stringify(c.output)}</pre>}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export default function Page({ params }) {
  const { runId } = use(params);
  return (
    <Suspense fallback={<div className="empty">Loading…</div>}>
      <Detail runId={runId} />
    </Suspense>
  );
}
