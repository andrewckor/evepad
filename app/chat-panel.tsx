"use client";

// Chat panel for a locally running agent. Talks to the eve HTTP API through the
// cockpit's proxy routes; the resulting session shows up in the runs table via
// the normal local poll, so chatting and observing share one pane.

import { useRef, useState } from "react";
import type React from "react";
import { motion } from "motion/react";
import { SPRING } from "./components/motion";
import { SidebarRight, PlusCircle, ChevronRight, ChevronDown } from "vercel-geist-icons";
import { Streamdown } from "streamdown";
import { MD_COMPONENTS } from "./components/markdown";
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
  const streamStarted = useRef(false);
  const continuation = useRef<string | null>(null); // follow-ups must echo the latest continuationToken

  // One long-lived NDJSON reader per session; events mutate the last assistant bubble.
  const startStream = (sid: string) => streamLoop(sid).catch(() => {}); // abort on unmount is expected
  const streamLoop = async (sid: string) => {
    if (streamStarted.current) return;
    streamStarted.current = true;
    const res = await fetch(
      `/api/chat/stream?port=${project.localPort}&sessionId=${encodeURIComponent(sid)}`,
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
  };

  // The transcript lives in a ref and is mirrored into state as a fresh array.
  // A setMessages(updater) that mutated its argument double-applied every event
  // under React StrictMode (dev double-invokes updaters to surface impurity),
  // which duplicated each assistant reply.
  const log = useRef<ChatMessage[]>([]);
  const applyEvent = (e: { type?: string; data?: Record<string, any> }) => {
    const d = e.data ?? {};
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
    if (typeof d.continuationToken === "string") continuation.current = d.continuationToken;
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
    if (!text || waiting) return;
    setInput("");
    log.current.push({ role: "user", text });
    setMessages([...log.current]);
    setWaiting(true);
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        port: project.localPort,
        sessionId,
        message: text,
        continuationToken: continuation.current,
      }),
    });
    const body = await r.json();
    if (body.continuationToken) continuation.current = body.continuationToken;
    if (!r.ok) {
      log.current.push({ role: "assistant", text: `⚠ ${body.error ?? "send failed"}`, done: true });
      setMessages([...log.current]);
      setWaiting(false);
      return;
    }
    if (!sessionId && body.sessionId) {
      setSessionId(body.sessionId);
      startStream(body.sessionId);
    }
  };

  const off = dock === "right" ? { x: "100%" } : { y: "100%" };
  return (
    <motion.aside
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
        <span className="dim">{project.name}</span>
        {sessionId && (
          <a
            className="dim2 mono"
            href={`/run/${sessionId}?environment=local&project=${encodeURIComponent(project.name)}`}
            title="Open this session's run detail"
          >
            {sessionId.slice(0, 14)}…
          </a>
        )}
        <div className="spacer" />
        <div className="term-actions">
          <button className="dockbtn" onClick={onNewChat} title="Start a new chat session">
            <PlusCircle />
          </button>
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
      <div className="chat-body">
        <MessageScrollerProvider autoScroll>
          <MessageScroller className="h-full">
            <MessageScrollerViewport>
              <MessageScrollerContent className="px-3 py-2">
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
                             tokens arrive); MD_COMPONENTS is our code block. */
                            <Streamdown className="chat-md" components={MD_COMPONENTS}>
                              {m.text}
                            </Streamdown>
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
            <button className="oc-send" onClick={send} disabled={waiting || !input.trim()}>
              <ArrowUp />
            </button>
          </div>
        </div>
      </div>
    </motion.aside>
  );
}
