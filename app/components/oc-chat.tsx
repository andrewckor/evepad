"use client";

// Custom OpenCode client — our components, their engine. Renders from
// /api/oc/messages hydration plus the /api/oc/events NDJSON stream; every
// action (prompt, slash command, abort, permission reply, new session) is a
// thin POST to /api/oc/act. Command parity comes from the server's own
// registry, so /undo, /models, /compact and custom commands all work here
// without reimplementation.

import React, { useState, useRef, useEffect, useCallback, startTransition } from "react";
import { Md } from "./md";
import { Button } from "@/components/ui/button";
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from "@/components/ui/message-scroller";
import { Message, MessageContent } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import LoadingState from "./loading-state";
import Thinking from "./thinking";
import FileDiff from "./file-diff";
import { ArrowUp, Plus, SlashForward } from "vercel-geist-icons";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { ChevronDownSmall } from "vercel-geist-icons";
import { MenuList, MenuLabel } from "./menu";
import type {
  OcPart,
  OcMessage,
  OcSession,
  OcPermission,
  OcQuestionRequest,
  OcWireMessage,
} from "./oc-types";
import type { ModelInfo } from "@/lib/opencode";
import type { ReactNode, ReactElement } from "react";

type BootState = {
  booting?: boolean;
  identity?: string;
  sessions: OcSession[];
  commands: Array<{ name: string; description?: string }>;
  models: ModelInfo[];
  agents?: Array<{ name: string; description?: string }>;
};
type DiffRow = { file: string; additions: number; deletions: number };
type ErrState = { kind: string; text: string };
type PaletteItem = { key: string; label: string; desc?: string; run: () => void };

// Base UI tooltips take a `render` element, not asChild.
const Tip = ({ label, children }: { label: ReactNode; children: ReactElement }) => (
  <Tooltip>
    <TooltipTrigger render={children} />
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>
);

// One question request, answered in place. Multi-question requests step
// through in order — the reply wants all answers at once (string[][]).
function QuestionCard({
  req,
  onReply,
  onReject,
}: {
  req: OcQuestionRequest;
  onReply: (answers: string[][]) => void;
  onReject: () => void;
}) {
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<string[][]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const q = req.questions[idx];
  if (!q) return null;
  const total = req.questions.length;
  const commit = (labels: string[]) => {
    if (!labels.length) return;
    const next = [...answers, labels];
    if (idx + 1 < total) {
      setAnswers(next);
      setPicked([]);
      setCustom("");
      setIdx(idx + 1);
    } else onReply(next);
  };
  const gathered = [...picked, ...(custom.trim() ? [custom.trim()] : [])];
  return (
    <div className="oc-perm oc-question">
      <div className="oc-q-head">
        {q.header && <span className="oc-q-chip">{q.header}</span>}
        {total > 1 && (
          <span className="oc-q-step">
            {idx + 1}/{total}
          </span>
        )}
        <span className="spacer" />
        <button className="oc-q-skip" title="Decline to answer" onClick={onReject}>
          Skip
        </button>
      </div>
      <div className="oc-q-text">{q.question}</div>
      <div className="oc-q-opts">
        {q.options.map((o) => (
          <button
            key={o.label}
            className="oc-q-opt"
            data-on={q.multiple && picked.includes(o.label) ? "1" : "0"}
            onClick={() =>
              q.multiple
                ? setPicked((ps) =>
                    ps.includes(o.label) ? ps.filter((x) => x !== o.label) : [...ps, o.label],
                  )
                : commit([o.label])
            }
          >
            <span className="oc-q-opt-label">{o.label}</span>
            {o.description && <span className="oc-q-opt-desc">{o.description}</span>}
          </button>
        ))}
      </div>
      {/* Free text renders regardless of q.custom: models rarely set it, and
          a picker whose options are all wrong dead-ends the run. The reply is
          plain strings, so an off-menu answer is valid. */}
      <div className="oc-q-foot">
        <input
          className="oc-q-input"
          value={custom}
          placeholder={q.multiple ? "Add your own…" : "Or type your own answer…"}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (q.multiple) commit(gathered);
            else if (custom.trim()) commit([custom.trim()]);
          }}
        />
        {/* Enter submits too, but a typed answer needs a visible button. */}
        <div className="oc-perm-actions">
          <Button
            variant="outline"
            size="sm"
            disabled={!gathered.length}
            onClick={() => commit(gathered)}
          >
            {idx + 1 < total ? "Next" : "Done"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Memoized row: parts mutate in place at token rate, so identity can't drive
// re-renders — a rev counter bumped on every change to that message does.
const MsgRow = React.memo(
  function MsgRow({
    m,
    live,
    project,
    diff,
  }: {
    m: OcMessage;
    rev?: number;
    live: boolean;
    project: string;
    diff: DiffRow[];
  }) {
    const parts = [...m.parts.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const isUser = m.info.role === "user";

    // Consecutive reasoning/tool parts collapse into one Thinking trace, so a
    // run of twelve tool calls reads as one thing the agent did rather than as
    // twelve loose rows. Text parts break the run — interleaved answers keep
    // their place in the transcript.
    type Group =
      | { type: "patch"; part: OcPart; key: string }
      | { type: "trace"; parts: OcPart[]; key: string }
      | { type: "text"; part: OcPart; key: string };
    const groups: Group[] = [];
    for (const p of parts) {
      const trace = p.type === "reasoning" || p.type === "tool";
      const tail = groups[groups.length - 1];
      // A patch part names the files THIS message wrote — the per-message
      // attribution session.diff can't give, since that one is session-wide.
      if (p.type === "patch") groups.push({ type: "patch", part: p, key: p.id });
      else if (trace && tail?.type === "trace") tail.parts.push(p);
      else if (trace) groups.push({ type: "trace", parts: [p], key: p.id });
      else groups.push({ type: "text", part: p, key: p.id });
    }

    return (
      <Message align={isUser ? "end" : "start"}>
        <MessageContent>
          {groups.map((g, gi) => {
            if (g.type === "text") {
              const p = g.part;
              if (p.type !== "text" || !p.text?.trim()) return null;
              return isUser ? (
                <Bubble key={g.key} variant="secondary" align="end" className="oc-bubble">
                  <BubbleContent>{p.text}</BubbleContent>
                </Bubble>
              ) : (
                <Md key={g.key} className="chat-md">
                  {p.text}
                </Md>
              );
            }
            if (g.type === "patch") {
              const files = g.part.files ?? [];
              if (!files.length) return null;
              return (
                <div key={g.key} className="oc-patch">
                  {files.map((f) => {
                    // Counts come from the session diff we already track, so the
                    // collapsed card is complete without fetching anything.
                    // Patch parts carry absolute paths, git reports repo-relative
                    // ones — match from whichever end is longer.
                    const d = diff?.find(
                      (x) => x.file === f || f.endsWith(x.file) || x.file.endsWith(f),
                    );
                    return (
                      <FileDiff
                        key={f}
                        project={project}
                        file={f}
                        additions={d?.additions}
                        deletions={d?.deletions}
                      />
                    );
                  })}
                </div>
              );
            }
            // A trace is working while any of its tools is, or while it is the
            // tail of the message the model is still streaming into.
            const busy =
              g.parts.some((p) => ["pending", "running"].includes(p.state?.status ?? "")) ||
              (live && gi === groups.length - 1);
            return <Thinking key={g.key} parts={g.parts} busy={busy} />;
          })}
        </MessageContent>
      </Message>
    );
  },
  (prev, next) =>
    prev.m === next.m &&
    prev.rev === next.rev &&
    prev.live === next.live &&
    prev.diff === next.diff,
);

// Consecutive tool-only turns render as ONE Thinking run — each tool call
// arrives as its own assistant message, and per-message grouping alone read
// as a stack of loose "Ran a command" rows. revKey carries the member
// revs, so streaming updates inside any member still re-render.
const TraceRun = React.memo(
  function TraceRun({ msgs, live }: { msgs: OcMessage[]; revKey: string; live: boolean }) {
    const parts = msgs.flatMap((m) =>
      [...m.parts.values()]
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .filter((p) => p.type === "reasoning" || p.type === "tool"),
    );
    const busy = live || parts.some((p) => ["pending", "running"].includes(p.state?.status ?? ""));
    return (
      <Message align="start">
        <MessageContent>
          <Thinking parts={parts} busy={busy} />
        </MessageContent>
      </Message>
    );
  },
  (prev, next) => prev.revKey === next.revKey && prev.live === next.live,
);

// A turn that carries nothing the transcript shows except its trace.
const traceOnly = (m: OcMessage) => {
  if (m.info.role !== "assistant") return false;
  const parts = [...m.parts.values()];
  return (
    parts.some((p) => p.type === "tool" || p.type === "reasoning") &&
    parts.every(
      (p) =>
        p.type === "tool" ||
        p.type === "reasoning" ||
        String(p.type).startsWith("step-") ||
        (p.type === "text" && !p.text?.trim()),
    )
  );
};

import { fetchJson } from "@/lib/fetch";

const ago = (t: number | null | undefined) => {
  if (!t) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return "now";
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 129600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

export default function OcChat({ project, onIdle }: { project: string; onIdle?: () => void }) {
  // Transcript lives in a ref (Map of messageID -> {info, parts: Map}) and is
  // mirrored to state via a version bump — StrictMode-safe, and deltas at
  // token rate don't reallocate the world.
  const store = useRef(new Map<string, OcMessage>());
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  // Deltas arrive at token rate — coalesce their re-renders.
  const bumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bumpSoon = () => {
    if (bumpTimer.current) return;
    bumpTimer.current = setTimeout(() => {
      bumpTimer.current = null;
      // Streaming updates are non-urgent: let typing/scrolling interrupt them.
      startTransition(() => setVersion((v) => v + 1));
    }, 80);
  };
  const touch = (msg: OcMessage) => {
    msg.rev = (msg.rev ?? 0) + 1;
  };
  const lastEventAt = useRef(0);
  // Merge server messages into the store WITHOUT replacing untouched message
  // objects — preserving identity keeps memoized rows mounted and the
  // scroller anchored (a full store swap remounts every row and jumps).
  const mergeMessages = (messages: OcWireMessage[]) => {
    let changed = false;
    for (const m of messages) {
      const existing = store.current.get(m.info.id);
      if (!existing) {
        store.current.set(m.info.id, {
          info: m.info,
          parts: new Map(m.parts.map((p) => [p.id, p])),
        });
        changed = true;
        continue;
      }
      for (const p of m.parts) {
        const prev = existing.parts.get(p.id);
        const prevLen = prev?.text?.length ?? 0;
        const nextLen = p.text?.length ?? 0;
        if (!prev || prev.state?.status !== p.state?.status || prevLen !== nextLen) {
          existing.parts.set(p.id, p);
          touch(existing);
          changed = true;
        }
      }
      if (existing.info.role !== m.info.role) {
        existing.info = m.info;
        touch(existing);
        changed = true;
      }
    }
    return changed;
  };

  const [boot, setBoot] = useState<BootState | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = sessionId;
  const [busy, setBusy] = useState(false);
  // Bumped whenever a run begins, so the elapsed timer restarts with it.
  const [sessOpen, setSessOpen] = useState(false);
  const [runKey, setRunKey] = useState(0);
  useEffect(() => {
    if (busy) setRunKey((k) => k + 1);
  }, [busy]);
  const [perms, setPerms] = useState<OcPermission[]>([]); // pending permission asks
  const [questions, setQuestions] = useState<OcQuestionRequest[]>([]); // pending elicitations
  // [{file, additions, deletions}] straight from git. OpenCode's session.diff
  // event fires but always carries an empty list on this server version, so
  // the counts — and the composer chip — came from nothing.
  const [diff, setDiff] = useState<DiffRow[]>([]);
  const [diffOpen, setDiffOpen] = useState(false);
  const [error, setError] = useState<ErrState | null>(null);
  const [input, setInput] = useState("");
  const [modelKey, setModelKey] = useState<string | null>(null);
  const [agentName, setAgentName] = useState<string | null>(null); // null = server default
  const [palIndex, setPalIndex] = useState(0);

  // Grow to five lines, then scroll — as an effect, not an onChange, so text
  // arriving from the palette or a graph action resizes the box too, and
  // clearing after send shrinks it back. The cap is read from the computed
  // line-height rather than hardcoded.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const line = parseFloat(getComputedStyle(el).lineHeight) || 21;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, line * 5) + "px";
  }, [input]);
  const [installing, setInstalling] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;
  const answered = useRef(new Set<string>());

  const idRef = useRef("anon");
  const skey = (k: string) => `${idRef.current}:${k}`;

  const refreshChanges = useCallback(() => {
    if (!project) return;
    fetch(`/api/oc/changes?project=${encodeURIComponent(project)}`)
      .then((r) => r.json())
      .then((d) => setDiff(d.files ?? []))
      .catch(() => {});
  }, [project]);
  // On arrival, and again once the agent stops working — those are the only
  // moments the working tree can have changed under us. Mount is covered too:
  // busy starts false, so this fires once on the way in.
  useEffect(() => {
    if (!busy) refreshChanges();
  }, [busy, refreshChanges]);

  const act = useCallback(
    (body: Record<string, unknown>): Promise<any> =>
      fetchJson("/api/oc/act", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, ...body }),
      }),
    [project],
  );

  // ---- boot: state + session choice (latest, else create on first send)
  useEffect(() => {
    let stale = false;
    setBoot(null);
    setError(null);
    store.current = new Map();
    bump();
    // wait=1 long-polls: the server holds the request and answers the moment
    // the opencode boot lands (8s ceiling per request) — no 400ms re-ask loop.
    // A fresh machine may be mid-download of opencode itself (installing) —
    // that's minutes, not seconds, so the deadline stretches to match.
    const load = async () => {
      const t0 = Date.now();
      let deadline = 60_000;
      while (!stale && Date.now() - t0 < deadline) {
        const b = await fetchJson(`/api/oc/state?project=${encodeURIComponent(project)}&wait=1`);
        if (!b?.booting) return b;
        if (b.installing) {
          deadline = 360_000;
          setInstalling(true);
        }
      }
      throw new Error("editor did not start");
    };
    load()
      .then((b) => {
        if (stale) return;
        setBoot(b);
        idRef.current = b.identity ?? "anon";
        const saved = sessionStorage.getItem(skey(`oc-session:${project}`));
        const pick = b.sessions.find((s: OcSession) => s.id === saved) ?? b.sessions[0];
        setSessionId(pick?.id ?? null);
        const savedModel = sessionStorage.getItem(skey("build-model"));
        const m =
          b.models.find((x: ModelInfo) => `${x.providerID}:${x.modelID}` === savedModel) ??
          b.models.find((x: ModelInfo) => x.default) ??
          b.models[0];
        if (m) setModelKey(`${m.providerID}:${m.modelID}`);
      })
      .catch((e: Error) => !stale && setError({ kind: "error", text: e.message }));
    return () => {
      stale = true;
    };
  }, [project]);

  // ---- hydrate transcript on session switch
  useEffect(() => {
    if (!sessionId) {
      store.current = new Map();
      bump();
      return;
    }
    sessionStorage.setItem(skey(`oc-session:${project}`), sessionId);
    let stale = false;
    fetchJson(`/api/oc/messages?project=${encodeURIComponent(project)}&session=${sessionId}`)
      .then(({ messages }: { messages: OcWireMessage[] }) => {
        if (stale) return;
        // Session switch: a fresh store is correct (merging would mix
        // transcripts). Mid-session refreshes go through mergeMessages.
        const next = new Map<string, OcMessage>();
        for (const m of messages) {
          next.set(m.info.id, { info: m.info, parts: new Map(m.parts.map((p) => [p.id, p])) });
        }
        store.current = next;
        // A transcript ending in an unfinished tool call means a run is still
        // live (or wedged on a permission ask we can't replay) — surface the
        // stop button so it's recoverable.
        const last = [...next.values()].at(-1);
        setBusy(
          !!last &&
            [...last.parts.values()].some(
              (p) => p.type === "tool" && ["pending", "running"].includes(p.state?.status ?? ""),
            ),
        );
        bump();
      })
      .catch((e: Error) => !stale && setError({ kind: "error", text: e.message }));
    return () => {
      stale = true;
    };
  }, [project, sessionId]);

  // ---- live events (one stream per project; reconnects with backoff)
  // Gated on boot: this stream never closes, and holding it open during the
  // boot window costs one of the browser's six HTTP/1.1 connections per host —
  // with state + manifest + projects already in flight, a page navigation
  // queued behind them and felt blocked. Nothing is missed by waiting: there
  // is no session to receive events for until boot resolves.
  const booted = Boolean(boot);
  useEffect(() => {
    if (!booted) return;
    let disposed = false;
    let abort: AbortController | undefined;
    (async () => {
      while (!disposed) {
        try {
          abort = new AbortController();
          const res = await fetch(`/api/oc/events?project=${encodeURIComponent(project)}`, {
            signal: abort.signal,
          });
          if (!res.ok) throw new Error("events unavailable");
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
              if (!line.trim()) continue;
              try {
                applyEvent(JSON.parse(line));
              } catch {}
            }
          }
        } catch {}
        if (!disposed) await new Promise((r) => setTimeout(r, 2000));
      }
    })();

    function applyEvent(ev: { type: string; properties?: Record<string, any> }) {
      lastEventAt.current = Date.now();
      const p = ev.properties ?? {};
      const sid = sessionRef.current;
      switch (ev.type) {
        case "message.updated": {
          if (p.info?.sessionID !== sid) return;
          const existing = store.current.get(p.info.id);
          store.current.set(p.info.id, { info: p.info, parts: existing?.parts ?? new Map() });
          // The real user message replaces our optimistic one.
          if (p.info.role === "user") {
            for (const k of store.current.keys())
              if (String(k).startsWith("local-")) store.current.delete(k);
          }
          bump();
          return;
        }
        case "message.part.updated": {
          const part = p.part;
          if (part?.sessionID !== sid) return;
          let msg = store.current.get(part.messageID);
          if (!msg) {
            msg = {
              info: {
                id: part.messageID,
                sessionID: sid ?? undefined,
                role: "assistant",
                localAt: Date.now(),
              },
              parts: new Map(),
            };
            store.current.set(part.messageID, msg);
          }
          msg.parts.set(part.id, part);
          touch(msg);
          bumpSoon();
          return;
        }
        case "message.part.delta": {
          if (p.sessionID !== sid) return;
          const msg = store.current.get(p.messageID);
          const part = msg?.parts.get(p.partID);
          if (msg && part && p.field === "text") {
            part.text = (part.text ?? "") + p.delta;
            touch(msg);
            bumpSoon();
          }
          return;
        }
        case "session.status": {
          if (p.sessionID !== sid) return;
          const t = p.status?.type ?? p.type;
          setBusy(t !== "idle");
          return;
        }
        case "session.diff": {
          if (p.sessionID !== sid) return;
          setDiff(p.diff ?? []);
          return;
        }
        case "session.idle": {
          if (p.sessionID !== sid) return;
          setBusy(false);
          onIdleRef.current?.();
          return;
        }
        case "session.error": {
          if (p.sessionID && p.sessionID !== sid) return;
          setBusy(false);
          const msg = String(p.error?.data?.message ?? p.error?.name ?? "session error");
          // A user-initiated stop is not an error — show it as quiet status.
          if (/abort/i.test(msg)) setError({ kind: "stopped", text: "stopped" });
          else setError({ kind: "error", text: msg.slice(0, 300) });
          return;
        }
        case "session.updated": {
          if (p.info)
            setBoot(
              (b) =>
                b && {
                  ...b,
                  sessions: [
                    { id: p.info.id, title: p.info.title, updated: p.info.time?.updated ?? 0 },
                    ...b.sessions.filter((s) => s.id !== p.info.id),
                  ],
                },
            );
          return;
        }
        // The live server emits permission.asked (SDK types say .updated —
        // they lag, like message.part.delta). Handle both.
        case "permission.asked":
        case "permission.updated": {
          // No session filter here: replayed asks can arrive before boot
          // resolves the session id. Filtered at render instead.
          setPerms((ps) => [...ps.filter((x) => x.id !== p.id), p as OcPermission]);
          return;
        }
        case "permission.replied": {
          setPerms((ps) => ps.filter((x) => x.id !== p.permissionID));
          return;
        }
        // Same replay caveat as permissions: no session filter here,
        // filtered at render.
        case "question.asked": {
          if (answered.current.has(p.id)) return;
          setQuestions((qs) => [...qs.filter((x) => x.id !== p.id), p as OcQuestionRequest]);
          return;
        }
        case "question.replied":
        case "question.rejected": {
          setQuestions((qs) => qs.filter((x) => x.id !== p.requestID));
          return;
        }
      }
    }

    return () => {
      disposed = true;
      abort?.abort();
    };
  }, [project, booted]);

  useEffect(() => {
    if (!busy || !sessionId) return;
    const pollPending = async () => {
      const { pending, questions: pendingQs } = await fetchJson(
        `/api/oc/pending?project=${encodeURIComponent(project)}&session=${sessionId}`,
      );
      // Keep array identity when nothing is new — this runs every 3s.
      if (pending) {
        setPerms((ps) => {
          let merged = ps;
          for (const p of pending) {
            if (answered.current.has(p.id)) continue;
            if (!merged.some((x) => x.id === p.id)) merged = [...merged, p];
          }
          return merged;
        });
      }
      if (pendingQs) {
        setQuestions((qs) => {
          let merged = qs;
          for (const q of pendingQs as OcQuestionRequest[]) {
            if (answered.current.has(q.id)) continue;
            if (!merged.some((x) => x.id === q.id)) merged = [...merged, q];
          }
          return merged;
        });
      }
    };
    const tick = async () => {
      try {
        // Always while busy — an ask raised during a bus gap never replays,
        // and the reconnected stream still looks healthy.
        await pollPending();
        // The transcript re-fetch stays gated on a dead bus: alongside live
        // events it double-rendered and yanked the scroller.
        if (Date.now() - lastEventAt.current < 4000) return;
        const { messages } = (await fetchJson(
          `/api/oc/messages?project=${encodeURIComponent(project)}&session=${sessionId}`,
        )) as { messages: OcWireMessage[] };
        const changed = mergeMessages(messages);
        const lastMsg = messages.at(-1);
        const waiting =
          lastMsg?.info.role === "assistant" &&
          lastMsg.parts.some(
            (p) => p.type === "tool" && ["pending", "running"].includes(p.state?.status ?? ""),
          );
        if (!waiting && lastMsg?.parts.some((p) => p.type === "step-finish")) setBusy(false);
        if (changed) bump();
      } catch {}
    };
    // Once on entry too: a reload into a waiting run must recover its asks.
    pollPending().catch(() => {});
    const iv = setInterval(tick, 3000);
    return () => clearInterval(iv);
  }, [busy, sessionId, project]);

  // By time, not id: an optimistic "local-…" id sorts before every server
  // "msg_…", so a message you just sent jumped to the top of the transcript.
  const msgs = [...store.current.values()].sort((a, b) => {
    const at = a.info.time?.created ?? a.info.localAt ?? 0;
    const bt = b.info.time?.created ?? b.info.localAt ?? 0;
    return at - bt || String(a.info.id).localeCompare(String(b.info.id));
  });
  // Adjacent tool-only turns collapse into one trace unit (see TraceRun).
  // Keyed by the first member, so a run that grows doesn't remount. Messages
  // with nothing to show yet (a streaming turn before its first part) are
  // skipped — as their own unit they steal `live` from the trace, which then
  // collapsed and reopened on every step of a run.
  type Unit = { key: string; run: OcMessage[] } | { key: string; msg: OcMessage };
  const units: Unit[] = [];
  for (const m of msgs) {
    const visible =
      m.info.role !== "assistant" ||
      [...m.parts.values()].some(
        (p) =>
          p.type === "tool" ||
          p.type === "reasoning" ||
          p.type === "patch" ||
          (p.type === "text" && p.text?.trim()),
      );
    if (!visible) continue;
    const tail = units[units.length - 1];
    if (traceOnly(m) && tail && "run" in tail) tail.run.push(m);
    else if (traceOnly(m)) units.push({ key: String(m.info.id), run: [m] });
    else units.push({ key: String(m.info.id), msg: m });
  }

  // ---- actions
  const selModel = boot?.models.find((m) => `${m.providerID}:${m.modelID}` === modelKey);
  const chooseModel = (key: string) => {
    setModelKey(key);
    sessionStorage.setItem(skey("build-model"), key);
    try {
      const h = (
        JSON.parse(localStorage.getItem(skey("oc-model-history")) ?? "[]") as string[]
      ).filter((k) => k !== key);
      localStorage.setItem(skey("oc-model-history"), JSON.stringify([key, ...h].slice(0, 8)));
    } catch {}
  };
  const ensureSession = async () => {
    if (sessionRef.current) return sessionRef.current;
    const created = await act({ action: "new" });
    setBoot(
      (b) =>
        b && {
          ...b,
          sessions: [{ id: created.id, title: created.title, updated: Date.now() }, ...b.sessions],
        },
    );
    setSessionId(created.id);
    sessionRef.current = created.id;
    return created.id;
  };

  const note = (text: string) => {
    const id = `note-${Date.now()}`;
    store.current.set(id, {
      info: {
        id,
        role: "assistant",
        sessionID: sessionRef.current ?? undefined,
        localAt: Date.now(),
      },
      parts: new Map([["p", { id: "p", type: "text", text }]]),
    });
    bump();
  };
  const rehydrate = async (sid: string) => {
    const { messages } = (await fetchJson(
      `/api/oc/messages?project=${encodeURIComponent(project)}&session=${sid}`,
    )) as { messages: OcWireMessage[] };
    const next = new Map<string, OcMessage>();
    for (const m of messages)
      next.set(m.info.id, { info: m.info, parts: new Map(m.parts.map((p) => [p.id, p])) });
    store.current = next;
    bump();
  };

  // TUI-parity built-ins. Pickers flip the palette into list mode; the rest
  // hit /api/oc/act endpoints directly. Registry commands come from boot.
  const BUILTINS = [
    { name: "models", description: "Switch model", picker: true },
    { name: "agents", description: "Switch agent", picker: true },
    { name: "sessions", description: "Switch session", picker: true },
    { name: "new", description: "Start a new session" },
    { name: "undo", description: "Revert the last assistant changes" },
    { name: "redo", description: "Restore reverted changes" },
    { name: "compact", description: "Summarize the session to shrink context" },
    { name: "share", description: "Share this session (returns a link)" },
    { name: "unshare", description: "Stop sharing this session" },
    { name: "export", description: "Download the transcript as JSON" },
    { name: "help", description: "List commands" },
  ];
  const allCommands = [...BUILTINS, ...(boot?.commands ?? [])];

  const runBuiltin = async (cmd: string) => {
    setInput("");
    const sid = await ensureSession();
    switch (cmd) {
      case "new": {
        const created = await act({ action: "new" });
        setBoot(
          (b) =>
            b && {
              ...b,
              sessions: [
                { id: created.id, title: created.title, updated: Date.now() },
                ...b.sessions,
              ],
            },
        );
        setSessionId(created.id);
        return;
      }
      case "undo":
      case "redo":
        await act({ action: cmd, sessionId: sid });
        await rehydrate(sid);
        note(cmd === "undo" ? "Reverted the last changes." : "Restored the reverted changes.");
        return;
      case "compact":
        setBusy(true);
        await act({
          action: "compact",
          sessionId: sid,
          provider: selModel?.providerID,
          model: selModel?.modelID,
        });
        return;
      case "share": {
        const r = await act({ action: "share", sessionId: sid });
        note(r.url ? `Session shared: ${r.url}` : "Session shared.");
        return;
      }
      case "unshare":
        await act({ action: "unshare", sessionId: sid });
        note("Sharing disabled.");
        return;
      case "export": {
        const { messages } = await fetchJson(
          `/api/oc/messages?project=${encodeURIComponent(project)}&session=${sid}`,
        );
        const blob = new Blob([JSON.stringify(messages, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${project}-${sid}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        return;
      }
      case "help":
        note(
          "**Commands**\n\n" +
            allCommands.map((c) => `- \`/${c.name}\` — ${c.description}`).join("\n"),
        );
        return;
    }
  };

  const send = async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text) return;
    setInput("");
    setError(null);
    try {
      const sid = await ensureSession();
      if (text.startsWith("/")) {
        const [cmd = "", ...rest] = text.slice(1).split(" ");
        const builtin = BUILTINS.find((c) => c.name === cmd);
        if (builtin?.picker) {
          setInput(`/${cmd} `);
          inputRef.current?.focus();
          return;
        }
        if (builtin) {
          await runBuiltin(cmd);
          return;
        }
        const known = boot?.commands.find((c) => c.name === cmd);
        if (known) {
          const localId = `local-${Date.now()}`;
          store.current.set(localId, {
            info: { id: localId, role: "user", sessionID: sid, localAt: Date.now() },
            parts: new Map([["p", { id: "p", type: "text", text }]]),
          });
          bump();
          setBusy(true);
          await act({
            action: "command",
            sessionId: sid,
            command: cmd,
            args: rest.join(" "),
            provider: selModel?.providerID,
            model: selModel?.modelID,
          });
          return;
        }
      }
      const localId = `local-${Date.now()}`;
      store.current.set(localId, {
        info: { id: localId, role: "user", sessionID: sid, localAt: Date.now() },
        parts: new Map([["p", { id: "p", type: "text", text }]]),
      });
      bump();
      setBusy(true);
      await act({
        action: "prompt",
        sessionId: sid,
        text,
        provider: selModel?.providerID,
        model: selModel?.modelID,
        agent: agentName,
      });
    } catch (e) {
      setError({ kind: "error", text: e instanceof Error ? e.message : String(e) });
      setBusy(false);
    }
  };

  // Graph buttons (and anything else in evepad) can hand us text.
  useEffect(() => {
    const h = (e: Event) => {
      const { text, submit } = (e as CustomEvent<{ text?: string; submit?: boolean }>).detail ?? {};
      if (!text) return;
      if (submit) send(text);
      else {
        setInput(text);
        inputRef.current?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("oc:send", h);
    return () => window.removeEventListener("oc:send", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot, modelKey, sessionId]);

  const respond = (perm: OcPermission, response: string) => {
    answered.current.add(perm.id);
    return act({
      action: "permission",
      sessionId: perm.sessionID,
      permissionId: perm.id,
      response,
      // "Always" saves these machine-wide so every agent inherits the answer.
      patterns: perm.patterns ?? [],
    })
      .then(() => setPerms((ps) => ps.filter((x) => x.id !== perm.id)))
      .catch(() => {
        // Log-derived ids can be stale (already answered) — drop silently.
        setPerms((ps) => ps.filter((x) => x.id !== perm.id));
      });
  };

  // ?ask=question — dev override, same shape as ?firstrun/?authfail. Read
  // from the URL, never stored, so a real ask always outranks it.
  useEffect(() => {
    if (process.env.NODE_ENV === "production" || !sessionId) return;
    if (new URLSearchParams(window.location.search).get("ask") !== "question") return;
    setQuestions([
      // Both card shapes: single-question and multi-question stepping.
      {
        id: "dev-question-single",
        sessionID: sessionId,
        questions: [
          {
            question: "How do you want to configure Slack credentials?",
            header: "Slack setup",
            options: [
              {
                label: "Vercel Connect",
                description: "OAuth via the platform — no tokens to manage",
              },
              { label: "Bot token", description: "Paste an xoxb- token into the environment" },
              { label: "Skip for now", description: "Wire credentials up later" },
            ],
            custom: true,
          },
        ],
      },
      {
        id: "dev-question-multi",
        sessionID: sessionId,
        questions: [
          {
            question: "Which events should the agent receive?",
            header: "Events",
            options: [
              { label: "Mentions", description: "Only when the bot is @-mentioned" },
              { label: "DMs", description: "Direct messages to the bot" },
              { label: "All channel messages", description: "Every message in joined channels" },
            ],
            multiple: true,
          },
          {
            question: "Should the agent reply in threads?",
            header: "Threading",
            options: [
              { label: "Threads", description: "Keep channels tidy" },
              { label: "Channel", description: "Reply at the top level" },
            ],
          },
        ],
      },
    ]);
  }, [sessionId]);

  // answers: string[][] — selected labels per question, in order. null rejects.
  const answerQuestion = (req: OcQuestionRequest, answers: string[][] | null) => {
    answered.current.add(req.id);
    const drop = () => setQuestions((qs) => qs.filter((x) => x.id !== req.id));
    return act({
      action: "question",
      requestId: req.id,
      response: answers ? "reply" : "reject",
      answers: answers ?? undefined,
    })
      .then(drop)
      .catch(drop); // stale ids (answered elsewhere) drop silently, like perms
  };

  // ---- palette: /cmd filters commands; "/models q", "/agents q",
  // "/sessions q" flip into searchable pickers.
  const palette: { items: PaletteItem[] } | null = (() => {
    if (!input.startsWith("/") || !boot) return null;
    const spaceAt = input.indexOf(" ");
    if (spaceAt === -1) {
      const q = input.slice(1).toLowerCase();
      const items = allCommands
        .map((c) => {
          const name = c.name.toLowerCase();
          const score = name.startsWith(q)
            ? 0
            : name.includes(q)
              ? 1
              : (c.description ?? "").toLowerCase().includes(q)
                ? 2
                : -1;
          return { c, score };
        })
        .filter((x) => x.score >= 0)
        .sort((a, b) => a.score - b.score || a.c.name.localeCompare(b.c.name))
        .slice(0, 9)
        .map(({ c }) => ({
          key: c.name,
          label: `/${c.name}`,
          desc: c.description,
          run: () => send(`/${c.name}`),
        }));
      return items.length ? { items } : null;
    }
    const tok = input.slice(1, spaceAt);
    const q = input.slice(spaceAt + 1).toLowerCase();
    if (tok === "models") {
      return {
        items: boot.models
          .filter((m) => (m.name + " " + m.modelID).toLowerCase().includes(q))
          .slice(0, 9)
          .map((m) => ({
            key: `${m.providerID}:${m.modelID}`,
            label: m.name,
            desc: `${m.provider}${m.free ? " · free" : ""}`,
            run: () => {
              chooseModel(`${m.providerID}:${m.modelID}`);
              setInput("");
            },
          })),
      };
    }
    if (tok === "agents") {
      return {
        items: (boot.agents ?? [])
          .filter((a) => a.name.toLowerCase().includes(q))
          .slice(0, 9)
          .map((a) => ({
            key: a.name,
            label: a.name + (agentName === a.name ? " ✓" : ""),
            desc: a.description,
            run: () => {
              setAgentName(a.name);
              setInput("");
            },
          })),
      };
    }
    if (tok === "sessions") {
      return {
        items: boot.sessions
          .filter((se) => (se.title ?? se.id).toLowerCase().includes(q))
          .slice(0, 9)
          .map((se) => ({
            key: se.id,
            label: (se.title ?? se.id).slice(0, 46),
            desc: se.id === sessionId ? "current" : ago(se.updated),
            run: () => {
              setSessionId(se.id);
              setInput("");
            },
          })),
      };
    }
    return null;
  })();
  useEffect(() => {
    setPalIndex(0);
  }, [input]);

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const items = palette?.items ?? [];
    if (items.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPalIndex((i) => (i + 1) % items.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPalIndex((i) => (i - 1 + items.length) % items.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const it = items[palIndex];
        if (it) setInput(`${it.label.startsWith("/") ? it.label : input} `);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        items[Math.min(palIndex, items.length - 1)]?.run();
        return;
      }
      if (e.key === "Escape") {
        setInput("");
        return;
      }
    }
    if (e.key === "Escape" && !input && busy && sessionId) {
      act({ action: "abort", sessionId }).catch(() => {});
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // Same scroll treatment as the runs table, vertical: no visible bar, and the
  // edge fades only on the side where content actually continues — a permanent
  // fade on a transcript that fits reads as a rendering bug.
  useEffect(() => {
    const el = bodyRef.current?.querySelector<HTMLElement>(
      '[data-slot="message-scroller-viewport"]',
    );
    if (!el) return;
    const update = () => {
      const room = el.scrollHeight - el.clientHeight;
      const state =
        room <= 1
          ? "none"
          : el.scrollTop <= 1
            ? "start"
            : el.scrollTop >= room - 1
              ? "end"
              : "middle";
      if (el.dataset.scroll !== state) el.dataset.scroll = state;
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const mo = new MutationObserver(update);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
      mo.disconnect();
    };
  }, [boot]);

  if (error && !boot)
    return (
      <div className="bad" style={{ padding: 16, fontSize: 13 }}>
        {error.text ?? String(error)}
      </div>
    );

  // Booting renders the real chrome — header, empty transcript, composer —
  // with a single line where the first thought will appear. A full-panel
  // spinner that then swaps for a different layout is the thing that makes a
  // web app feel like a web app.
  const booting = !boot;
  const sessions = boot?.sessions ?? [];
  const visiblePerms = perms.filter((perm) => perm.sessionID === sessionId);
  const visibleQuestions = questions.filter((q) => q.sessionID === sessionId);
  // While an ask is on screen the "Working" pulse yields — the agent isn't
  // working, it's waiting on you.
  const waitingOnUser = visiblePerms.length > 0 || visibleQuestions.length > 0;

  return (
    <>
      <div className="oc-head">
        <TooltipProvider delay={300}>
          {/* A Popover, not a Select: sessions are a browsable list — titles
            run long and each carries a timestamp — and a select's tight rows
            left no room for either. */}
          <Popover open={sessOpen} onOpenChange={setSessOpen}>
            <PopoverTrigger className="oc-session-trigger" disabled={booting}>
              <span className="oc-session-name">
                {booting
                  ? project
                  : (
                      sessions.find((se) => se.id === sessionId)?.title ??
                      sessionId ??
                      "new session"
                    ).slice(0, 40)}
              </span>
              <span className="oc-session-chev">
                <ChevronDownSmall />
              </span>
            </PopoverTrigger>
            <PopoverContent align="start" className="oc-sesspop menu-pop">
              <MenuLabel>Sessions</MenuLabel>
              <MenuList scroll max={320}>
                {sessions.map((se) => (
                  <button
                    key={se.id}
                    className={"menu-row" + (se.id === sessionId ? " on" : "")}
                    onClick={() => {
                      setSessionId(se.id);
                      setSessOpen(false);
                    }}
                  >
                    <span className="menu-row-label">{se.title ?? se.id}</span>
                    <span className="menu-row-trail oc-ago">{ago(se.updated)}</span>
                  </button>
                ))}
              </MenuList>
            </PopoverContent>
          </Popover>
          <Tip label="Start a new chat">
            <Button
              variant="outline"
              size="icon-sm"
              className="oc-newchat"
              disabled={booting}
              onClick={async () => {
                try {
                  const created = await act({ action: "new" });
                  setBoot(
                    (b) =>
                      b && {
                        ...b,
                        sessions: [
                          { id: created.id, title: created.title, updated: Date.now() },
                          ...b.sessions,
                        ],
                      },
                  );
                  setSessionId(created.id);
                } catch (e) {
                  setError({ kind: "error", text: e instanceof Error ? e.message : String(e) });
                }
              }}
            >
              <Plus />
            </Button>
          </Tip>
        </TooltipProvider>
        <div className="spacer" />
      </div>

      <div className="oc-body" ref={bodyRef}>
        <MessageScrollerProvider autoScroll>
          <MessageScroller className="h-full">
            <MessageScrollerViewport className="oc-scroll">
              {/* pb clears the status overlay: the scroll area runs full
                  height, but the transcript's last line never rests under
                  the working/diff strip pinned to its bottom. */}
              <MessageScrollerContent className="px-6 py-6 pb-11">
                {!booting && !msgs.length && (
                  <div className="chat-empty">
                    <div className="dim">
                      Build chat for <b>{project}</b> — OpenCode under the hood, evepad UI on top.
                      Ask, change code, or type <span className="mono">/</span> for commands (
                      <span className="mono">/undo</span>,<span className="mono"> /models</span>,{" "}
                      <span className="mono">/compact</span>…).
                    </div>
                  </div>
                )}
                {units.map((u, i) => (
                  <MessageScrollerItem key={u.key} messageId={u.key}>
                    {/* only the trailing unit can still be streaming — a
                        blanket `busy` would set every trace shimmering. */}
                    {"run" in u ? (
                      <TraceRun
                        msgs={u.run}
                        revKey={u.run.map((m) => `${m.info.id}:${m.rev ?? 0}`).join(",")}
                        live={busy && i === units.length - 1}
                      />
                    ) : (
                      <MsgRow
                        m={u.msg}
                        rev={u.msg.rev ?? 0}
                        live={busy && i === units.length - 1}
                        project={project}
                        diff={diff}
                      />
                    )}
                  </MessageScrollerItem>
                ))}
                {error && boot && (
                  <div className={"oc-notice" + (error.kind === "stopped" ? " quiet" : "")}>
                    <span>{error.kind === "stopped" ? "■ stopped" : error.text}</span>
                    <button className="oc-notice-x" title="Dismiss" onClick={() => setError(null)}>
                      ×
                    </button>
                  </div>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>

        <div className={"oc-status" + (booting || (busy && !waitingOnUser) ? " working" : "")}>
          <span className={"oc-status-inner" + (booting || (busy && !waitingOnUser) ? " on" : "")}>
            {/* Connecting borrows the thinking indicator's slot — the place
              this panel already says what it is doing. Keyed on the run so
              the timer starts with the work, not with the page. */}
            <LoadingState
              key={booting ? "boot" : runKey}
              label={
                booting
                  ? installing
                    ? "Setting up the editor — one-time download"
                    : "Connecting to the editor"
                  : "Working"
              }
              elapsed={!booting}
            />
          </span>
          <span className="spacer" />
          {diff.length > 0 && (
            // The app's popover: outside-click and Escape dismissal come with
            // it, and the positioner keeps a wide diff on screen.
            <Popover open={diffOpen} onOpenChange={setDiffOpen}>
              <PopoverTrigger className="oc-diff-chip mono">
                <span>
                  {diff.length} file{diff.length === 1 ? "" : "s"} changed
                </span>
                <span className="ok"> +{diff.reduce((n, d) => n + d.additions, 0)}</span>
                <span className="bad"> −{diff.reduce((n, d) => n + d.deletions, 0)}</span>
              </PopoverTrigger>
              <PopoverContent side="top" align="end" sideOffset={8} className="oc-diff-pop">
                {diff.map((d) => (
                  <FileDiff
                    key={d.file}
                    project={project}
                    file={d.file}
                    additions={d.additions}
                    deletions={d.deletions}
                  />
                ))}
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>

      <div className="chat-composer">
        {/* Approval floats over the transcript like the slash palette: a run
            is blocked until you answer, so it belongs next to the input you
            are already looking at — not parked at the bottom of a transcript
            you may have scrolled away from. */}
        {waitingOnUser && (
          <div className="oc-perm-dock">
            {visibleQuestions.map((req) => (
              <QuestionCard
                key={req.id}
                req={req}
                onReply={(answers) => answerQuestion(req, answers)}
                onReject={() => answerQuestion(req, null)}
              />
            ))}
            {visiblePerms.map((perm) => (
              <div className="oc-perm" key={perm.id}>
                <div className="oc-perm-title mono">
                  <b>{perm.permission ?? perm.type}</b>{" "}
                  {typeof perm.metadata?.command === "string"
                    ? perm.metadata.command
                    : (perm.patterns ?? []).join(", ") || perm.title}
                </div>
                <div className="oc-perm-actions">
                  <Button variant="outline" size="sm" onClick={() => respond(perm, "once")}>
                    Allow once
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => respond(perm, "always")}>
                    Always
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="oc-deny"
                    onClick={() => respond(perm, "reject")}
                  >
                    Deny
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
        {/* Same primitives as every other menu: the --menu-pad ring, flush
            --menu-row-h rows, and the hidden scrollbar with faded edges. This
            was the last popover in the app still carrying its own paddings. */}
        {palette && (
          <div className="oc-palette menu-pop">
            <MenuList scroll max={300}>
              {palette.items.map((it, i) => (
                <button
                  key={it.key}
                  className="menu-row"
                  data-on={i === palIndex ? "1" : "0"}
                  onMouseEnter={() => setPalIndex(i)}
                  onClick={() => it.run()}
                >
                  <span className="mono oc-cmd-name">{it.label}</span>
                  <span className="oc-cmd-desc">{it.desc}</span>
                </button>
              ))}
            </MenuList>
          </div>
        )}
        <div className="oc-card">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder={
              busy ? "working… (you can queue the next message)" : `Ask or change ${project}…`
            }
            className="oc-ta thinbar"
            disabled={booting}
            autoFocus
          />
          <div className="oc-card-row">
            <TooltipProvider delay={300}>
              <Tip label="Commands — same as typing /">
                <button
                  className="oc-plus"
                  disabled={booting}
                  onClick={() => {
                    setInput("/");
                    inputRef.current?.focus({ preventScroll: true });
                  }}
                >
                  <SlashForward />
                </button>
              </Tip>
              {/* One button, two jobs — the same place you send from is the
                  place you stop from, as every other AI chat does it. */}
              {busy ? (
                <Tip label="Stop">
                  <button
                    className="oc-send stop"
                    onClick={() => sessionId && act({ action: "abort", sessionId }).catch(() => {})}
                  >
                    <span className="oc-stopsq" />
                  </button>
                </Tip>
              ) : (
                <Tip label="Send">
                  <button
                    className="oc-send"
                    onClick={() => send()}
                    disabled={booting || !input.trim()}
                  >
                    <ArrowUp />
                  </button>
                </Tip>
              )}
            </TooltipProvider>
          </div>
        </div>
        <div className="chat-model oc-model-row">
          {/* Read-only: /models is the switcher, so a picker here would be a
              second way to do one thing. */}
          {/* Always rendered, faded until the model is known — the row's
              height is reserved, so the composer doesn't jump when it
              arrives. */}
          <span
            className="oc-modelname"
            style={{ opacity: selModel ? 1 : 0 }}
            title="Active model — change it with /models"
          >
            {selModel ? `${selModel.name}${selModel.free ? " · free" : ""}` : "\u00a0"}
          </span>
          {agentName && (
            <span className="oc-agent mono" title="Active agent (set via /agents)">
              {agentName}
            </span>
          )}
        </div>
      </div>
    </>
  );
}
