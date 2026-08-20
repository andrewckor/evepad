"use client";

// Chat panel for a locally running agent. Talks to the eve HTTP API through the
// cockpit's proxy routes; the resulting session shows up in the runs table via
// the normal local poll, so chatting and observing share one pane.

import { useRef, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import type React from "react";
import { m as M } from "motion/react";
import { SPRING } from "./components/motion";
import {
  SidebarRight,
  ChevronRight,
  ChevronDown,
  ChevronDownSmall,
  Plus,
} from "vercel-geist-icons";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { MenuLabel, MenuList } from "./components/menu";
import { getJson, fetchJson } from "@/lib/fetch";
import { ago } from "@/lib/format";
import { Md } from "./components/md";
import LoadingState from "./components/loading-state";
import { Check } from "vercel-geist-icons";
import { ArrowUp } from "vercel-geist-icons";
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

import type { Project, Dock } from "@/lib/types";

type ChatTool = { callId: string; name: string; status: string };
type ChatMessage = { role: "user" | "assistant"; text: string; tools?: ChatTool[]; done?: boolean };

export default function ChatPanel({
  project,
  dock,
  onDock,
  size,
  onSize,
  clamp,
  onResizing,
  onNewChat,
  seed,
  onClose,
}: {
  project: Project;
  dock: Dock;
  onDock: (d: Dock) => void;
  size: number;
  onSize: (v: number) => void;
  clamp: (v: number) => number;
  onResizing?: (v: boolean) => void;
  onNewChat: () => void;
  seed?: string | null;
  onClose: () => void;
}) {
  // Same drag-resize contract as the terminal — one shared panel geometry.
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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState(seed ?? "");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false); // a turn is in flight
  // Durable workflows: a reset or completed run is over — its chat is
  // read-only and new messages need a new session.
  const [ended, setEnded] = useState(false);
  const markEnded = () => {
    setEnded(true);
    setWaiting(false);
    const note = "*This chat's workflow ended — it can't continue. Start a new chat.*";
    if (log.current[log.current.length - 1]?.text !== note) {
      log.current.push({ role: "assistant", text: note, done: true });
      setMessages([...log.current]);
    }
  };
  const streamStarted = useRef(false);
  const streamAbort = useRef<AbortController | null>(null);
  // Resume watermark: eve replays the session's whole event history when a
  // stream connects; the transcript is already hydrated from the run detail,
  // so older events are dropped.
  const replayCutoff = useRef(0);
  const [sessOpen, setSessOpen] = useState(false);

  // Chat history = this agent's local runs; every conversation IS a run, so
  // the runs API is already the session list — titles, timestamps and all.
  const { data: histData, mutate: refreshHistory } = useSWR<{
    sessions?: { runId: string; title: string; createdAt: string }[];
  }>(`/api/runs?environment=local&project=${encodeURIComponent(project.name)}&period=7d`, getJson, {
    keepPreviousData: true,
  });
  const history = histData?.sessions ?? [];
  const currentTitle = history.find((h) => h.runId === sessionId)?.title ?? "New chat";

  // Resume: rebuild the transcript from the run detail (message.received /
  // message.completed pairs), then keep talking on the same session id — the
  // eve API keys the conversation on the session alone.
  const resume = async (runId: string) => {
    setSessOpen(false);
    if (runId === sessionId || waiting) return;
    streamAbort.current?.abort();
    streamStarted.current = false;
    replayCutoff.current = Date.now();
    let status = "";
    try {
      const d = await fetchJson(
        `/api/run/${encodeURIComponent(runId)}?environment=local&project=${encodeURIComponent(project.name)}`,
      );
      status = d.session?.status ?? "";
      log.current = (d.turns ?? []).flatMap(
        (t: { messages?: { type: string; text: string | null }[] }) =>
          (t.messages ?? [])
            .filter((mm) => mm.text && ["message.received", "message.completed"].includes(mm.type))
            .map((mm): ChatMessage => ({
              role: mm.type === "message.received" ? "user" : "assistant",
              text: mm.text ?? "",
              done: true,
            })),
      );
    } catch {
      log.current = [];
    }
    const over = status === "completed" || status === "failed";
    setEnded(false);
    setMessages([...log.current]);
    setSessionId(runId);
    if (over) markEnded();
    else startStream(runId);
  };

  const sessionAct = (action: "cancel" | "reset") =>
    fetchJson("/api/chat/act", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: project.localPort, sessionId, action }),
    });

  // Stops the in-flight turn; the session lives on. The stream's own
  // turn.cancelled event clears `waiting`, this only sends the order.
  const cancelTurn = () => {
    if (!sessionId || !waiting) return;
    sessionAct("cancel").catch(() => {});
  };

  // One long-lived NDJSON reader per session; events mutate the last assistant bubble.
  const startStream = (sid: string) => streamLoop(sid).catch(() => {}); // abort on unmount is expected
  const streamLoop = async (sid: string) => {
    if (streamStarted.current) return;
    streamStarted.current = true;
    // One live stream at a time: switching sessions aborts the old reader, or
    // its events would keep landing in the new transcript.
    const ctrl = new AbortController();
    streamAbort.current = ctrl;
    const res = await fetch(
      `/api/chat/stream?port=${project.localPort}&sessionId=${encodeURIComponent(sid)}`,
      { signal: ctrl.signal },
    );
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        let e: { type?: string; data?: Record<string, any> };
        try {
          e = JSON.parse(s);
        } catch {
          continue;
        }
        applyEvent(e);
      }
    }
    // The server closed the stream. For a durable workflow that usually means
    // the run ended (reset from the run page, or completed) — confirm before
    // locking, so a transient disconnect doesn't kill a healthy chat.
    if (!ctrl.signal.aborted) {
      try {
        const d = await fetchJson(
          `/api/run/${encodeURIComponent(sid)}?environment=local&project=${encodeURIComponent(project.name)}&fresh=1`,
        );
        const st = d.session?.status;
        if (st === "completed" || st === "failed") markEnded();
      } catch {}
    }
  };

  // The transcript lives in a ref and is mirrored into state as a fresh array.
  // A setMessages(updater) that mutated its argument double-applied every event
  // under React StrictMode (dev double-invokes updaters to surface impurity),
  // which duplicated each assistant reply.
  const log = useRef<ChatMessage[]>([]);
  const applyEvent = (e: { type?: string; data?: Record<string, any>; meta?: { at?: string } }) => {
    const d = e.data ?? {};
    const at = Date.parse(e.meta?.at ?? "");
    if (at && at < replayCutoff.current) return;
    const msgs = log.current;
    const last = msgs[msgs.length - 1];
    const assistant = (): ChatMessage => {
      if (!last || last.role !== "assistant" || last.done) {
        const fresh: ChatMessage = { role: "assistant", text: "", tools: [], done: false };
        msgs.push(fresh);
        return fresh;
      }
      return last;
    };
    if (e.type === "message.appended" && typeof d.messageSoFar === "string") {
      assistant().text = d.messageSoFar;
    } else if (e.type === "message.completed") {
      const a = assistant();
      if (typeof d.message === "string") a.text = d.message;
      a.done = true;
    } else if (e.type === "actions.requested") {
      const a = assistant();
      for (const act of d.actions ?? [])
        a.tools!.push({ callId: act.callId, name: act.toolName, status: "running" });
    } else if (e.type === "action.result") {
      for (const m of msgs)
        for (const t of m.tools ?? [])
          if (t.callId === d.result?.callId) t.status = d.status ?? "completed";
    }
    setMessages([...msgs]);
    if (
      e.type === "session.waiting" ||
      e.type === "turn.completed" ||
      e.type === "turn.cancelled"
    ) {
      setWaiting(false);
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || waiting || ended) return;
    setInput("");
    log.current.push({ role: "user", text });
    setMessages([...log.current]);
    setWaiting(true);
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // No continuationToken: eve keys the conversation on the session id and
      // REJECTS a token on /session/:id posts (it broke every follow-up).
      body: JSON.stringify({
        port: project.localPort,
        sessionId,
        message: text,
      }),
    });
    const body = await r.json();
    if (!r.ok) {
      // The workflow ended under us (reset from the run page, or completed):
      // durable workflows can't continue — lock the chat and say so.
      if (body.code === "session_not_active") {
        streamAbort.current?.abort();
        markEnded();
        return;
      }
      log.current.push({ role: "assistant", text: `⚠ ${body.error ?? "send failed"}`, done: true });
      setMessages([...log.current]);
      setWaiting(false);
      return;
    }
    if (!sessionId && body.sessionId) {
      setSessionId(body.sessionId);
      startStream(body.sessionId);
      // The new run needs a moment to appear in the runs API — then the
      // session pill can pick up its title.
      setTimeout(() => refreshHistory(), 2_000);
    }
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
        <b>Chat with</b>
        <span className="dim term-title">{project.name}</span>
        <div className="spacer" />
        <div className="term-actions">
          <button
            className="dockbtn"
            onClick={() => onDock(dock === "right" ? "bottom" : "right")}
            title={dock === "right" ? "Dock to bottom" : "Dock to right"}
          >
            <SidebarRight style={dock === "right" ? { transform: "rotate(90deg)" } : undefined} />
          </button>
          <button className="closebtn" onClick={onClose} title="Close panel">
            {dock === "right" ? <ChevronRight /> : <ChevronDown />}
          </button>
        </div>
      </div>
      {/* Session tabs, borrowed from the Build editor: the current chat as a
          pill that opens the history (local runs ARE the chats), plus a +
          for a fresh one. */}
      <div className="chat-tabs">
        <Popover open={sessOpen} onOpenChange={setSessOpen}>
          <PopoverTrigger className="oc-session-trigger">
            <span className="oc-session-name">{currentTitle.slice(0, 40)}</span>
            <span className="oc-session-chev">
              <ChevronDownSmall />
            </span>
          </PopoverTrigger>
          <PopoverContent align="start" className="oc-sesspop menu-pop">
            <MenuLabel>Chats</MenuLabel>
            <MenuList scroll max={320}>
              {history.length === 0 && <div className="menu-row dim2">No chats yet</div>}
              {history.map((h) => (
                <button
                  key={h.runId}
                  className={"menu-row" + (h.runId === sessionId ? " on" : "")}
                  onClick={() => resume(h.runId)}
                >
                  <span className="menu-row-label">{h.title || h.runId}</span>
                  <span className="menu-row-trail oc-ago">{ago(h.createdAt)}</span>
                </button>
              ))}
            </MenuList>
          </PopoverContent>
        </Popover>
        <Button
          variant="outline"
          size="icon-sm"
          className="oc-newchat"
          title="Start a new chat session"
          onClick={onNewChat}
        >
          <Plus />
        </Button>
      </div>
      <div className="chat-body">
        <MessageScrollerProvider autoScroll>
          <MessageScroller className="h-full">
            <MessageScrollerViewport>
              <MessageScrollerContent className="px-3 py-2">
                {sessionId && (
                  /* Client-side navigation on purpose: a plain <a> reloads the
                     app and takes the open chat with it. */
                  <Link
                    className="chat-runid mono"
                    href={`/run/${sessionId}?environment=local&project=${encodeURIComponent(project.name)}`}
                    title="Open this session's run detail"
                  >
                    {sessionId.replace(/^wrun_/, "")}
                  </Link>
                )}
                {!messages.length && (
                  <div className="chat-empty">
                    <div className="dim">
                      This starts a <b>new chat session</b> with <b>{project.name}</b> on :
                      {project.localPort}.
                    </div>
                    <div className="dim2">
                      Every conversation becomes a run in the table — click its id up top to inspect
                      it.
                    </div>
                  </div>
                )}
                {messages.map((m, i) => (
                  <MessageScrollerItem
                    key={i}
                    messageId={String(i)}
                    scrollAnchor={m.role === "user"}
                  >
                    <Message align={m.role === "user" ? "end" : "start"}>
                      <MessageContent>
                        {/* Same rows the Build editor's trace uses, so a tool
                            call looks like a tool call everywhere. */}
                        {(m.tools ?? []).map((t) => (
                          <div key={t.callId} className="th-row static">
                            <span className="th-ic">
                              {t.status === "running" ? <span className="th-spin" /> : <Check />}
                            </span>
                            <span className="th-name">{t.name}</span>
                          </div>
                        ))}
                        {m.text &&
                          (m.role === "user" ? (
                            <Bubble variant="secondary" align="end" className="oc-bubble">
                              <BubbleContent>{m.text}</BubbleContent>
                            </Bubble>
                          ) : (
                            /* Bare markdown, like the editor — the agent's answer
                             is the page, not a card on it. Streamdown renders
                             safely mid-stream (unclosed ** and ``` while
                             tokens arrive); the code block is ours. */
                            <Md className="chat-md">{m.text}</Md>
                          ))}
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                ))}
                {waiting && (
                  <MessageScrollerItem messageId="thinking">
                    <LoadingState label="Working" />
                  </MessageScrollerItem>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      </div>
      {!ended && (
        <div className="chat-composer">
          <div className="oc-card">
            <textarea
              rows={1}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                const el = e.target;
                const line = parseFloat(getComputedStyle(el).lineHeight) || 21;
                el.style.height = "auto";
                el.style.height = Math.min(el.scrollHeight, line * 5) + "px";
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={waiting ? "waiting for the agent…" : `Message ${project.name}…`}
              className="oc-ta"
              disabled={waiting}
              autoFocus
            />
            <div className="oc-card-row">
              <span />
              {waiting ? (
                <button className="oc-send stop" onClick={cancelTurn} title="Cancel this turn">
                  <span className="oc-stopsq" />
                </button>
              ) : (
                <button className="oc-send" onClick={send} disabled={!input.trim()}>
                  <ArrowUp />
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </M.aside>
  );
}
