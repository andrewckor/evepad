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
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  return v >= 1000 ? (v / 1000).toFixed(1).replace(/\.0$/, "") + "K" : String(v);
};
const dur = (ms) => {
  if (ms == null) return "—";
  if (ms < 1000) return ms + "ms";
  const s = ms / 1000;
  return (s < 10 ? s.toFixed(2).replace(/\.?0+$/, "") : Math.round(s)) + "s";
};
const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return Math.floor(s) + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + " day" + (s < 172800 ? "" : "s") + " ago";
};
const statusClass = (s) => (s === "completed" ? "ok" : s === "failed" ? "bad" : "warn");

import { I } from "../../components/icons.jsx";

const W = { link: I.wrench, clock: I.clock, dollar: I.coins, chevRight: I.chevRight, chevDown: I.chevDown, copy: I.copy, external: I.external };

// Minimal JSON syntax coloring in the Vercel style: strings green, literals red.
function Json({ value }) {
  const text = JSON.stringify(value, null, 2) ?? "";
  const parts = text.split(/("(?:[^"\\]|\\.)*")|(\btrue\b|\bfalse\b|\bnull\b|-?\d+\.?\d*)/g);
  return (
    <pre className="json">
      {parts.map((p, i) => {
        if (p == null) return null;
        if (/^"/.test(p)) {
          // keys end with ": — leave them default; values go green
          return <span key={i} className={parts[i + 2]?.startsWith?.(":") || text.indexOf(p + ":") !== -1 ? "j-key" : "j-str"}>{p}</span>;
        }
        if (/^(true|false|null|-?\d)/.test(p)) return <span key={i} className="j-lit">{p}</span>;
        return <span key={i}>{p}</span>;
      })}
    </pre>
  );
}

function Section({ title, right, children, defaultOpen = true }) {
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

function Pills({ options, value, onChange }) {
  return (
    <span className="pills">
      {options.map((o) => (
        <button key={o} data-on={o === value ? "1" : "0"} onClick={() => onChange(o)}>{o}</button>
      ))}
    </span>
  );
}

// Shape-matched skeleton: same layout as the loaded page, so nothing jumps.
function DetailSkeleton() {
  return (
    <>
      <div className="detail">
        <div className="transcript">
          <div className="sk bubble" />
          <div className="sk turn" />
          <div className="sk turn" style={{ opacity: 0.6 }} />
        </div>
        <div className="side">
          {[90, 70, 80, 60, 75, 65].map((w, i) => (
            <div key={i} className="sk line" style={{ width: `${w}%`, marginBottom: 12 }} />
          ))}
          <div className="sk turn" style={{ marginTop: 22 }} />
        </div>
      </div>
    </>
  );
}

// One tool call rendered Vercel-style inside the Timeline: summary row with a
// green duration bar, then Input/Output JSON blocks.
// Collapsed by default like Vercel's, with a gray inline preview of the input
// args after the tool name; click to expand the full Input/Output JSON.
function TimelineCall({ call, maxMs }) {
  const [open, setOpen] = useState(false);
  const preview = call.input ? JSON.stringify(call.input).replace(/[{}"]/g, "").slice(0, 14) + "…" : "";
  return (
    <div className="tlitem">
      <div className="tl" onClick={() => setOpen((o) => !o)} style={{ cursor: "pointer" }}>
        <span className={call.status === "completed" ? "ok" : "warn"}>✓</span>
        <span className="nm">{call.toolName} <span className="dim2">{preview}</span></span>
        <span className="bar"><i style={{ width: `${Math.max(((call.durationMs ?? 0) / maxMs) * 100, 4)}%` }} /></span>
        <span className="ms">{dur(call.durationMs)}</span>
      </div>
      {open && (
        <div className="tlio">
          <div className="io-label">Input</div>
          <Json value={call.input} />
          {call.output != null && (<><div className="io-label">Output</div><Json value={call.output} /></>)}
        </div>
      )}
    </div>
  );
}

function Detail({ runId }) {
  const router = useRouter();
  const q = useSearchParams();
  const environment = q.get("environment") ?? "local";
  const period = q.get("period") ?? DEFAULT_PERIOD;
  const project = q.get("project") ?? "";
  const selectedTurnId = q.get("selectedTurnId");

  // Carry every filter back, or returning from a run silently resets them.
  const backHref = `/?environment=${environment}&period=${period}&project=${encodeURIComponent(project)}`;

  const tab = q.get("tab") ?? "turns";
  const setTab = (t) => {
    const next = new URLSearchParams(q.toString());
    next.set("tab", t);
    router.replace(`/run/${runId}?${next.toString()}`, { scroll: false });
  };
  const [inputView, setInputView] = useState("Markdown");
  const [tlView, setTlView] = useState("Markdown");
  const isLocal = environment === "local";

  const { data: run, isLoading, error } = useSWR(
    `/api/run/${encodeURIComponent(runId)}?environment=${environment}&project=${encodeURIComponent(project)}`,
    fetcher,
    { refreshInterval: isLocal ? 2000 : 0, revalidateOnFocus: isLocal, keepPreviousData: true },
  );

  if (error) {
    return (
      <div className="empty">
        {error.message}
        <div style={{ marginTop: 14 }}><Link className="mono" href={backHref}>← back to Agent Runs</Link></div>
      </div>
    );
  }
  if (isLoading && !run) return <DetailSkeleton />;
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
  const selInput = selected?.messages.find((m) => m.type === "message.received")?.text ?? null;
  const selFinal = selected ? [...selected.messages].reverse().find((m) => m.type === "message.completed")?.text : null;

  const kvRows = [
    ["Status", <span key="s" className={statusClass(run.session.status)}>{run.session.status}</span>],
    // Vercel shows these as relative times.
    ["Start Time", ago(selected?.startedAt ?? run.session.createdAt)],
    ["End Time", selected?.endedAt ? ago(selected.endedAt) : "—"],
    ["Duration", dur(selected?.durationMs)],
    ["Workflow Run", <span key="w" className="mono">{run.session.runId.replace(/^wrun_/, "").slice(0, 14)}…</span>],
    ["Model", ta["$eve.model"] ?? "—"],
    ["Cost", money(ta["$eve.cost_usd"] ?? stepUsage.cost)],
    ["Input Tokens", kt(ta["$eve.input_tokens"] ?? stepUsage.input)],
    ["Cache Read Tokens", kt(ta["$eve.cache_read_tokens"] ?? stepUsage.cacheRead)],
    ["Cache Write Tokens", kt(ta["$eve.cache_write_tokens"] ?? stepUsage.cacheWrite)],
    ["Output Tokens", kt(ta["$eve.output_tokens"] ?? stepUsage.output)],
  ];

  return (
    <>
      <div className="detail">
        <div className="transcript">
          <div className="float-tabs">
            <button className="tab" data-on={tab === "turns" ? "1" : "0"} onClick={() => setTab("turns")}>Turns</button>
            <button className="tab" data-on={tab === "metadata" ? "1" : "0"} onClick={() => setTab("metadata")}>Metadata</button>
          </div>
          <div className="transcript-inner">
          {run.note && <div className="note">{run.note}</div>}

          {tab === "metadata" ? (
            <>
              <div className="sec"><h3>Session attributes</h3><Json value={a} /></div>
              {run.childRuns.map((c) => (
                <div className="sec" key={c.runId}><h3>{c.workflowName}</h3><Json value={c.attributes} /></div>
              ))}
            </>
          ) : (
            <>
              {turns.map((t) => {
                const tc = t.steps.flatMap((s) => s.calls).length;
                const cost = t.steps.reduce((n, s) => n + (s.usage?.costUsd ?? 0), 0);
                const userMsg = t.messages.find((m) => m.type === "message.received")?.text;
                const final = [...t.messages].reverse().find((m) => m.type === "message.completed")?.text;
                return (
                  <div key={t.turnId}>
                    {userMsg && (
                      <div className="bubble">
                        {userMsg}
                        {/^https?:\/\/\S+$/.test(userMsg.trim()) && (
                          <a href={userMsg.trim()} target="_blank" rel="noreferrer" className="bubble-ext" onClick={(e) => e.stopPropagation()}>{I.external ?? "↗"}</a>
                        )}
                      </div>
                    )}
                    <div
                      className={"turncard" + (t.turnId === selected?.turnId ? " sel" : "")}
                      onClick={() => selectTurn(t.turnId)}
                    >
                      <div className="turnhead">
                        <span className="stat">{W.link} {tc}</span>
                        <span className="stat">{I.clock} {dur(t.durationMs)}</span>
                        <span className="stat">{W.dollar} {money(cost)}</span>
                        <div className="spacer" />
                        <span className="dim2">{I.chevRight}</span>
                      </div>
                      {final && <div className="turnbody">{final}</div>}
                    </div>
                  </div>
                );
              })}
              {!turns.length && !run.note && <div className="empty">No turns recorded.</div>}
            </>
          )}
          </div>
        </div>

        <div className="side">
          <div className="side-title">
            <span className="mono">{selected?.turnId ?? "session"}</span>
            <div className="spacer" />
            <button className="copybtn" title="Copy run id" onClick={() => navigator.clipboard?.writeText(runId)}>{I.copy}</button>
          </div>

          <Section title="Metadata">
            {kvRows.map(([k, v]) => (
              <div className="kv" key={k}><span className="k">{k}</span><span className="v">{v}</span></div>
            ))}
          </Section>

          {selInput != null && (
            <Section title="Input" right={<Pills options={["Markdown", "Raw"]} value={inputView} onChange={setInputView} />}>
              {inputView === "Raw" ? <Json value={selInput} /> : <div className="prose">{selInput}</div>}
            </Section>
          )}

          {selected && (
            <Section title="Timeline" right={<Pills options={["Markdown", "Raw"]} value={tlView} onChange={setTlView} />}>
              {tlView === "Raw" ? (
                <Json value={selected.steps} />
              ) : (
                <>
                  {calls.map((c) => <TimelineCall key={c.callId} call={c} maxMs={maxCall} />)}
                  {!calls.length && <div className="dim2 mono">no tool calls</div>}
                  {selFinal && <div className="prose" style={{ marginTop: 10 }}>{selFinal}</div>}
                </>
              )}
            </Section>
          )}

          {selected && (
            <Section title="Steps" defaultOpen={false}>
              {selected.steps.map((s) => (
                <div className="tool" key={s.stepIndex}>
                  <div className="kv"><span className="k">step {s.stepIndex}</span><span className="v">{s.finishReason ?? "—"}</span></div>
                  {s.usage && (
                    <div className="dim2 mono">{money(s.usage.costUsd)} · {s.usage.inputTokens} in / {s.usage.outputTokens} out</div>
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

export default function Page({ params }) {
  const { runId } = use(params);
  return (
    <Suspense fallback={<div className="empty">Loading…</div>}>
      <Detail runId={runId} />
    </Suspense>
  );
}
