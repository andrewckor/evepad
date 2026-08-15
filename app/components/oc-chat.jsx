"use client";

// Custom OpenCode client — our components, their engine. Renders from
// /api/oc/messages hydration plus the /api/oc/events NDJSON stream; every
// action (prompt, slash command, abort, permission reply, new session) is a
// thin POST to /api/oc/act. Command parity comes from the server's own
// registry, so /undo, /models, /compact and custom commands all work here
// without reimplementation.

import React, { useState, useRef, useEffect, useCallback, startTransition } from "react";
import { Streamdown } from "streamdown";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MessageScrollerProvider, MessageScroller, MessageScrollerViewport,
  MessageScrollerContent, MessageScrollerItem, MessageScrollerButton,
} from "@/components/ui/message-scroller";
import { Message, MessageContent } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Marker, MarkerIcon, MarkerContent } from "@/components/ui/marker";
import {
  Select, SelectTrigger, SelectContent, SelectItem, SelectGroup, SelectLabel, SelectValue,
} from "@/components/ui/select";
import { ArrowUp, Plus, Terminal, Pencil, MagnifyingGlass, Globe, Wrench, Stop, CrossCircle } from "vercel-geist-icons";

// Geist icon per opencode tool — nearest concept, never invented (AGENTS.md).
const TOOL_ICONS = {
  bash: <Terminal />, edit: <Pencil />, write: <Pencil />,
  read: <MagnifyingGlass />, glob: <MagnifyingGlass />, grep: <MagnifyingGlass />, list: <MagnifyingGlass />,
  webfetch: <Globe />,
};

// Memoized row: parts mutate in place at token rate, so identity can't drive
// re-renders — a rev counter bumped on every change to that message does.
// Generative ASCII loader (see .agents/skills/ascii-animation): a traveling
// sine field rendered through a shaded-block brightness ramp into a <pre>.
// Writes textContent directly via rAF — zero React re-renders, ~20fps.
const RAMP = " \u00B7\u2591\u2592\u2593\u2588"; // ' ·░▒▓█' dark -> light
function AsciiLoader({ cols = 10, rows = 1, className = "" }) {
  const ref = React.useRef(null);
  useEffect(() => {
    let raf, last = 0;
    const tick = (t) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 50) return; // 20fps is plenty (skill: 12-24fps)
      last = t;
      let out = "";
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const v = Math.sin(x * 0.9 - t * 0.005 + y * 1.3) + Math.sin((x + y) * 0.5 - t * 0.0031);
          const lum = Math.min(1, Math.max(0, (v + 2) / 4));
          out += RAMP[Math.round(lum * (RAMP.length - 1))];
        }
        if (y < rows - 1) out += "\n";
      }
      if (ref.current) ref.current.textContent = out;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cols, rows]);
  return <pre ref={ref} className={"ascii-load " + className} aria-label="working" />;
}

const MsgRow = React.memo(function MsgRow({ m }) {
  // Expanded thought/tool-output rows; local to the row, survives memo skips.
  const [openParts, setOpenParts] = React.useState(() => new Set());
  const toggle = (id) => setOpenParts((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const parts = [...m.parts.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const isUser = m.info.role === "user";
  return (
    <Message align={isUser ? "end" : "start"}>
      <MessageContent>
        {parts.map((p) => {
          if (p.type === "text") {
            if (!p.text?.trim()) return null;
            return isUser ? (
              <Bubble key={p.id} variant="default" align="end">
                <BubbleContent>{p.text}</BubbleContent>
              </Bubble>
            ) : (
              <Streamdown key={p.id} className="chat-md">{p.text}</Streamdown>
            );
          }
          if (p.type === "reasoning") {
            // Native-opencode style: a dim collapsed "thought" row; click for
            // the full reasoning text.
            if (!p.text?.trim()) return null;
            const ms = p.time?.end && p.time?.start ? p.time.end - p.time.start : null;
            const dur = ms == null ? "" : ms < 1000 ? ` ${ms}ms` : ` ${(ms / 1000).toFixed(1)}s`;
            const open = openParts.has(p.id);
            return (
              <div key={p.id}>
                <button className="oc-thought mono" onClick={() => toggle(p.id)}>
                  ✱ thought{dur}
                </button>
                {open && <div className="oc-thought-body">{p.text}</div>}
              </div>
            );
          }
          if (p.type === "tool") {
            const st = p.state?.status;
            const output = p.state?.output;
            const open = openParts.has(p.id);
            const expandable = st === "completed" && output;
            return (
              <div key={p.id}>
                <Marker
                  className={"oc-" + (st ?? "pending") + (expandable ? " oc-expandable" : "")}
                  onClick={expandable ? () => toggle(p.id) : undefined}
                  role={expandable ? "button" : undefined}
                >
                  <MarkerIcon>
                    {st === "error" ? <CrossCircle />
                      : ["pending", "running"].includes(st) ? <AsciiLoader cols={2} rows={2} className="mini" />
                      : (TOOL_ICONS[p.tool] ?? <Wrench />)}
                  </MarkerIcon>
                  <MarkerContent className="mono">
                    {p.tool} <span className="dim2">{partLabel(p)}</span>
                  </MarkerContent>
                </Marker>
                {open && (
                  <pre className="oc-tool-out">{String(output).slice(0, 4000)}</pre>
                )}
              </div>
            );
          }
          return null;
        })}
      </MessageContent>
    </Message>
  );
}, (prev, next) => prev.m === next.m && prev.rev === next.rev);

const fetchJson = async (url, opts) => {
  const r = await fetch(url, opts);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? "request failed");
  return body;
};

const ago = (t) => {
  if (!t) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return "now";
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 129600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

function partLabel(part) {
  const input = part.state?.input ?? {};
  const file = input.filePath ?? input.path;
  if (file) return String(file).split("/").slice(-2).join("/");
  if (input.command) return String(input.command).slice(0, 64);
  if (input.pattern) return String(input.pattern).slice(0, 64);
  return "";
}

export default function OcChat({ project, onIdle }) {
  // Transcript lives in a ref (Map of messageID -> {info, parts: Map}) and is
  // mirrored to state via a version bump — StrictMode-safe, and deltas at
  // token rate don't reallocate the world.
  const store = useRef(new Map());
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  // Deltas arrive at token rate — coalesce their re-renders.
  const bumpTimer = useRef(null);
  const bumpSoon = () => {
    if (bumpTimer.current) return;
    bumpTimer.current = setTimeout(() => {
      bumpTimer.current = null;
      // Streaming updates are non-urgent: let typing/scrolling interrupt them.
      startTransition(() => setVersion((v) => v + 1));
    }, 80);
  };
  const touch = (msg) => { msg.rev = (msg.rev ?? 0) + 1; };
  const lastEventAt = useRef(0);
  // Merge server messages into the store WITHOUT replacing untouched message
  // objects — preserving identity keeps memoized rows mounted and the
  // scroller anchored (a full store swap remounts every row and jumps).
  const mergeMessages = (messages) => {
    let changed = false;
    for (const m of messages) {
      const existing = store.current.get(m.info.id);
      if (!existing) {
        store.current.set(m.info.id, { info: m.info, parts: new Map(m.parts.map((p) => [p.id, p])) });
        changed = true;
        continue;
      }
      for (const p of m.parts) {
        const prev = existing.parts.get(p.id);
        const prevLen = (prev?.text?.length ?? 0);
        const nextLen = (p.text?.length ?? 0);
        if (!prev || prev.state?.status !== p.state?.status || prevLen !== nextLen) {
          existing.parts.set(p.id, p);
          touch(existing);
          changed = true;
        }
      }
      if (existing.info.role !== m.info.role) { existing.info = m.info; touch(existing); changed = true; }
    }
    return changed;
  };

  const [boot, setBoot] = useState(null); // {sessions, commands, models, defaults}
  const [sessionId, setSessionId] = useState(null);
  const sessionRef = useRef(null);
  sessionRef.current = sessionId;
  const [busy, setBusy] = useState(false);
  const [perms, setPerms] = useState([]); // pending permission asks
  const [diff, setDiff] = useState([]);   // [{file, additions, deletions}] for this session
  const [diffOpen, setDiffOpen] = useState(false);
  const [error, setError] = useState(null);
  const [input, setInput] = useState("");
  const [modelKey, setModelKey] = useState(null);
  const [agentName, setAgentName] = useState(null); // null = server default
  const [palIndex, setPalIndex] = useState(0);
  const inputRef = useRef(null);
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;
  const answered = useRef(new Set());

  const idRef = useRef("anon");
  const skey = (k) => `${idRef.current}:${k}`;

  const act = useCallback((body) =>
    fetchJson("/api/oc/act", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, ...body }),
    }), [project]);

  // ---- boot: state + session choice (latest, else create on first send)
  useEffect(() => {
    let stale = false;
    setBoot(null); setError(null); store.current = new Map(); bump();
    fetchJson(`/api/oc/state?project=${encodeURIComponent(project)}`)
      .then((b) => {
        if (stale) return;
        setBoot(b);
        idRef.current = b.identity ?? "anon";
        const saved = sessionStorage.getItem(skey(`oc-session:${project}`));
        const pick = b.sessions.find((s) => s.id === saved) ?? b.sessions[0];
        setSessionId(pick?.id ?? null);
        const savedModel = sessionStorage.getItem(skey("build-model"));
        const m = b.models.find((x) => `${x.providerID}:${x.modelID}` === savedModel)
          ?? b.models.find((x) => x.default) ?? b.models[0];
        if (m) setModelKey(`${m.providerID}:${m.modelID}`);
      })
      .catch((e) => !stale && setError({ kind: "error", text: e.message }));
    return () => { stale = true; };
  }, [project]);

  // ---- hydrate transcript on session switch
  useEffect(() => {
    if (!sessionId) { store.current = new Map(); bump(); return; }
    sessionStorage.setItem(skey(`oc-session:${project}`), sessionId);
    let stale = false;
    fetchJson(`/api/oc/messages?project=${encodeURIComponent(project)}&session=${sessionId}`)
      .then(({ messages }) => {
        if (stale) return;
        // Session switch: a fresh store is correct (merging would mix
        // transcripts). Mid-session refreshes go through mergeMessages.
        const next = new Map();
        for (const m of messages) {
          next.set(m.info.id, { info: m.info, parts: new Map(m.parts.map((p) => [p.id, p])) });
        }
        store.current = next;
        // A transcript ending in an unfinished tool call means a run is still
        // live (or wedged on a permission ask we can't replay) — surface the
        // stop button so it's recoverable.
        const last = [...next.values()].at(-1);
        setBusy(!!last && [...last.parts.values()].some(
          (p) => p.type === "tool" && ["pending", "running"].includes(p.state?.status),
        ));
        bump();
      })
      .catch((e) => !stale && setError({ kind: "error", text: e.message }));
    return () => { stale = true; };
  }, [project, sessionId]);

  // ---- live events (one stream per project; reconnects with backoff)
  useEffect(() => {
    let disposed = false;
    let abort;
    (async () => {
      while (!disposed) {
        try {
          abort = new AbortController();
          const res = await fetch(`/api/oc/events?project=${encodeURIComponent(project)}`, { signal: abort.signal });
          if (!res.ok) throw new Error("events unavailable");
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done || disposed) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop();
            for (const line of lines) {
              if (!line.trim()) continue;
              try { applyEvent(JSON.parse(line)); } catch {}
            }
          }
        } catch {}
        if (!disposed) await new Promise((r) => setTimeout(r, 2000));
      }
    })();

    const applyEvent = (ev) => {
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
            for (const k of store.current.keys()) if (String(k).startsWith("local-")) store.current.delete(k);
          }
          bump();
          return;
        }
        case "message.part.updated": {
          const part = p.part;
          if (part?.sessionID !== sid) return;
          let msg = store.current.get(part.messageID);
          if (!msg) { msg = { info: { id: part.messageID, sessionID: sid, role: "assistant" }, parts: new Map() }; store.current.set(part.messageID, msg); }
          msg.parts.set(part.id, part);
          touch(msg);
          bumpSoon();
          return;
        }
        case "message.part.delta": {
          if (p.sessionID !== sid) return;
          const msg = store.current.get(p.messageID);
          const part = msg?.parts.get(p.partID);
          if (part && p.field === "text") { part.text = (part.text ?? "") + p.delta; touch(msg); bumpSoon(); }
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
          if (p.info) setBoot((b) => b && {
            ...b,
            sessions: [{ id: p.info.id, title: p.info.title, updated: p.info.time?.updated ?? 0 },
              ...b.sessions.filter((s) => s.id !== p.info.id)],
          });
          return;
        }
        // The live server emits permission.asked (SDK types say .updated —
        // they lag, like message.part.delta). Handle both.
        case "permission.asked":
        case "permission.updated": {
          // No session filter here: replayed asks can arrive before boot
          // resolves the session id. Filtered at render instead.
          setPerms((ps) => [...ps.filter((x) => x.id !== p.id), p]);
          return;
        }
        case "permission.replied": {
          setPerms((ps) => ps.filter((x) => x.id !== p.permissionID));
          return;
        }
      }
    };

    return () => { disposed = true; abort?.abort(); };
  }, [project]);

  useEffect(() => {
    if (!busy || !sessionId) return;
    const tick = async () => {
      // Events healthy -> nothing to do. This poll exists solely for a dead
      // bus; running it alongside live events double-rendered the transcript
      // and yanked the scroller every 3 seconds.
      if (Date.now() - lastEventAt.current < 4000) return;
      try {
        const { messages } = await fetchJson(`/api/oc/messages?project=${encodeURIComponent(project)}&session=${sessionId}`);
        const changed = mergeMessages(messages);
        const lastMsg = messages.at(-1);
        const waiting = lastMsg?.info.role === "assistant" &&
          lastMsg.parts.some((p) => p.type === "tool" && ["pending", "running"].includes(p.state?.status));
        if (!waiting && lastMsg?.parts.some((p) => p.type === "step-finish")) setBusy(false);
        if (changed) bump();
        const { pending } = await fetchJson(`/api/oc/pending?project=${encodeURIComponent(project)}&session=${sessionId}`);
        if (pending) {
          setPerms((ps) => {
            const merged = [...ps];
            for (const p of pending) {
              if (answered.current.has(p.id)) continue;
              if (!merged.some((x) => x.id === p.id)) merged.push(p);
            }
            return merged;
          });
        }
      } catch {}
    };
    const iv = setInterval(tick, 3000);
    return () => clearInterval(iv);
  }, [busy, sessionId, project]);

  const msgs = [...store.current.values()].sort((a, b) => String(a.info.id).localeCompare(String(b.info.id)));

  // ---- actions
  const selModel = boot?.models.find((m) => `${m.providerID}:${m.modelID}` === modelKey);
  const chooseModel = (key) => {
    setModelKey(key);
    sessionStorage.setItem(skey("build-model"), key);
    try {
      const h = JSON.parse(localStorage.getItem(skey("oc-model-history")) ?? "[]").filter((k) => k !== key);
      localStorage.setItem(skey("oc-model-history"), JSON.stringify([key, ...h].slice(0, 8)));
    } catch {}
  };
  // The dropdown mounts every item on open — 194 Radix rows cost ~360ms. Keep
  // it to current + recents + defaults; the /models palette is the browser.
  const shortModels = (() => {
    if (!boot) return [];
    let history = [];
    try { history = JSON.parse(localStorage.getItem(skey("oc-model-history")) ?? "[]"); } catch {}
    const keys = [...new Set([
      modelKey,
      ...history,
      `${boot.defaults.provider}:${boot.defaults.model}`,
      "vercel:zai/glm-5.2-fast",
    ].filter(Boolean))];
    return keys.map((k) => boot.models.find((m) => `${m.providerID}:${m.modelID}` === k)).filter(Boolean).slice(0, 10);
  })();
  const ensureSession = async () => {
    if (sessionRef.current) return sessionRef.current;
    const created = await act({ action: "new" });
    setBoot((b) => b && { ...b, sessions: [{ id: created.id, title: created.title, updated: Date.now() }, ...b.sessions] });
    setSessionId(created.id);
    sessionRef.current = created.id;
    return created.id;
  };

  const note = (text) => {
    const id = `note-${Date.now()}`;
    store.current.set(id, {
      info: { id, role: "assistant", sessionID: sessionRef.current },
      parts: new Map([["p", { id: "p", type: "text", text }]]),
    });
    bump();
  };
  const rehydrate = async (sid) => {
    const { messages } = await fetchJson(`/api/oc/messages?project=${encodeURIComponent(project)}&session=${sid}`);
    const next = new Map();
    for (const m of messages) next.set(m.info.id, { info: m.info, parts: new Map(m.parts.map((p) => [p.id, p])) });
    store.current = next; bump();
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

  const runBuiltin = async (cmd) => {
    setInput("");
    const sid = await ensureSession();
    switch (cmd) {
      case "new": {
        const created = await act({ action: "new" });
        setBoot((b) => b && { ...b, sessions: [{ id: created.id, title: created.title, updated: Date.now() }, ...b.sessions] });
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
        await act({ action: "compact", sessionId: sid, provider: selModel?.providerID, model: selModel?.modelID });
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
        const { messages } = await fetchJson(`/api/oc/messages?project=${encodeURIComponent(project)}&session=${sid}`);
        const blob = new Blob([JSON.stringify(messages, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${project}-${sid}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        return;
      }
      case "help":
        note("**Commands**\n\n" + allCommands.map((c) => `- \`/${c.name}\` — ${c.description}`).join("\n"));
        return;
    }
  };

  const send = async (raw) => {
    const text = (raw ?? input).trim();
    if (!text) return;
    setInput(""); setError(null);
    try {
      const sid = await ensureSession();
      if (text.startsWith("/")) {
        const [cmd, ...rest] = text.slice(1).split(" ");
        const builtin = BUILTINS.find((c) => c.name === cmd);
        if (builtin?.picker) { setInput(`/${cmd} `); inputRef.current?.focus(); return; }
        if (builtin) { await runBuiltin(cmd); return; }
        const known = boot?.commands.find((c) => c.name === cmd);
        if (known) {
          store.current.set(`local-${Date.now()}`, {
            info: { id: `local-${Date.now()}`, role: "user", sessionID: sid },
            parts: new Map([["p", { id: "p", type: "text", text }]]),
          });
          bump(); setBusy(true);
          await act({ action: "command", sessionId: sid, command: cmd, args: rest.join(" "), provider: selModel?.providerID, model: selModel?.modelID });
          return;
        }
      }
      store.current.set(`local-${Date.now()}`, {
        info: { id: `local-${Date.now()}`, role: "user", sessionID: sid },
        parts: new Map([["p", { id: "p", type: "text", text }]]),
      });
      bump(); setBusy(true);
      await act({ action: "prompt", sessionId: sid, text, provider: selModel?.providerID, model: selModel?.modelID, agent: agentName });
    } catch (e) { setError({ kind: "error", text: e.message }); setBusy(false); }
  };

  // Graph buttons (and anything else in the cockpit) can hand us text.
  useEffect(() => {
    const h = (e) => {
      const { text, submit } = e.detail ?? {};
      if (!text) return;
      if (submit) send(text);
      else { setInput(text); inputRef.current?.focus({ preventScroll: true }); }
    };
    window.addEventListener("oc:send", h);
    return () => window.removeEventListener("oc:send", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot, modelKey, sessionId]);

  const respond = (perm, response) => {
    answered.current.add(perm.id);
    return act({ action: "permission", sessionId: perm.sessionID, permissionId: perm.id, response })
      .then(() => setPerms((ps) => ps.filter((x) => x.id !== perm.id)))
      .catch(() => {
        // Log-derived ids can be stale (already answered) — drop silently.
        setPerms((ps) => ps.filter((x) => x.id !== perm.id));
      });
  };

  // ---- palette: /cmd filters commands; "/models q", "/agents q",
  // "/sessions q" flip into searchable pickers.
  const palette = (() => {
    if (!input.startsWith("/") || !boot) return null;
    const spaceAt = input.indexOf(" ");
    if (spaceAt === -1) {
      const q = input.slice(1).toLowerCase();
      const items = allCommands
        .map((c) => {
          const name = c.name.toLowerCase();
          const score = name.startsWith(q) ? 0
            : name.includes(q) ? 1
            : (c.description ?? "").toLowerCase().includes(q) ? 2
            : -1;
          return { c, score };
        })
        .filter((x) => x.score >= 0)
        .sort((a, b) => a.score - b.score || a.c.name.localeCompare(b.c.name))
        .slice(0, 9)
        .map(({ c }) => ({ key: c.name, label: `/${c.name}`, desc: c.description, run: () => send(`/${c.name}`) }));
      return items.length ? { items } : null;
    }
    const tok = input.slice(1, spaceAt);
    const q = input.slice(spaceAt + 1).toLowerCase();
    if (tok === "models") {
      return { items: boot.models
        .filter((m) => (m.name + " " + m.modelID).toLowerCase().includes(q))
        .slice(0, 9)
        .map((m) => ({
          key: `${m.providerID}:${m.modelID}`,
          label: m.name,
          desc: `${m.provider}${m.free ? " · free" : ""}`,
          run: () => { chooseModel(`${m.providerID}:${m.modelID}`); setInput(""); },
        })) };
    }
    if (tok === "agents") {
      return { items: (boot.agents ?? [])
        .filter((a) => a.name.toLowerCase().includes(q))
        .slice(0, 9)
        .map((a) => ({
          key: a.name,
          label: a.name + (agentName === a.name ? " ✓" : ""),
          desc: a.description,
          run: () => { setAgentName(a.name); setInput(""); },
        })) };
    }
    if (tok === "sessions") {
      return { items: boot.sessions
        .filter((se) => (se.title ?? se.id).toLowerCase().includes(q))
        .slice(0, 9)
        .map((se) => ({
          key: se.id,
          label: (se.title ?? se.id).slice(0, 46),
          desc: se.id === sessionId ? "current" : ago(se.updated),
          run: () => { setSessionId(se.id); setInput(""); },
        })) };
    }
    return null;
  })();
  useEffect(() => { setPalIndex(0); }, [input]);

  const onKey = (e) => {
    const items = palette?.items ?? [];
    if (items.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setPalIndex((i) => (i + 1) % items.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setPalIndex((i) => (i - 1 + items.length) % items.length); return; }
      if (e.key === "Tab") { e.preventDefault(); setInput(`${items[palIndex].label.startsWith("/") ? items[palIndex].label : input} `); return; }
      if (e.key === "Enter") { e.preventDefault(); items[Math.min(palIndex, items.length - 1)].run(); return; }
      if (e.key === "Escape") { setInput(""); return; }
    }
    if (e.key === "Escape" && !input && busy && sessionId) {
      act({ action: "abort", sessionId }).catch(() => {});
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  if (error && !boot) return <div className="bad" style={{ padding: 16, fontSize: 13 }}>{error.text ?? String(error)}</div>;
  if (!boot) return <div className="dim mono" style={{ padding: 16, display: "flex", gap: 8, alignItems: "center" }}><AsciiLoader cols={14} rows={2} /> <span className="oc-shimmer">connecting to opencode…</span></div>;

  const visiblePerms = perms.filter((perm) => perm.sessionID === sessionId);

  return (
    <>
      <div className="oc-head">
        <Select value={sessionId ?? ""} onValueChange={(v) => v && setSessionId(v)}>
          <SelectTrigger size="sm" className="oc-session-trigger" title="Session">
            <SelectValue placeholder="new session">
              {(boot.sessions.find((se) => se.id === sessionId)?.title ?? sessionId ?? "new session").slice(0, 40)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {boot.sessions.map((se) => (
              <SelectItem key={se.id} value={se.id}>{(se.title ?? se.id).slice(0, 42)}<span className="oc-ago">{ago(se.updated)}</span></SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="icon-sm"
          title="New session"
          onClick={async () => {
            try {
              const created = await act({ action: "new" });
              setBoot((b) => b && { ...b, sessions: [{ id: created.id, title: created.title, updated: Date.now() }, ...b.sessions] });
              setSessionId(created.id);
            } catch (e) { setError({ kind: "error", text: e.message }); }
          }}
        ><Plus /></Button>
        <div className="spacer" />
        {busy && (
          <Button
            variant="outline"
            size="sm"
            className="oc-abort"
            onClick={() => sessionId && act({ action: "abort", sessionId }).catch(() => {})}
          ><Stop /> Stop</Button>
        )}
      </div>

      <div className="oc-body">
        <MessageScrollerProvider autoScroll>
          <MessageScroller className="h-full">
            <MessageScrollerViewport>
              <MessageScrollerContent className="px-3 py-2">
                {!msgs.length && (
                  <div className="chat-empty">
                    <div className="dim">Build chat for <b>{project}</b> — OpenCode under the hood, cockpit UI on top.
                      Ask, change code, or type <span className="mono">/</span> for commands (<span className="mono">/undo</span>,
                      <span className="mono"> /models</span>, <span className="mono">/compact</span>…).</div>
                  </div>
                )}
                {msgs.map((m) => (
                  <MessageScrollerItem key={m.info.id} messageId={String(m.info.id)}>
                    <MsgRow m={m} rev={m.rev ?? 0} />
                  </MessageScrollerItem>
                ))}
                {visiblePerms.map((perm) => (
                  <MessageScrollerItem key={perm.id} messageId={perm.id}>
                    <div className="oc-perm">
                      <div className="oc-perm-title mono">{perm.permission ?? perm.type}: {perm.metadata?.command ?? (perm.patterns ?? []).join(", ") ?? perm.title}</div>
                      <div className="oc-perm-actions">
                        <Button variant="outline" size="sm" onClick={() => respond(perm, "once")}>Allow once</Button>
                        <Button variant="outline" size="sm" onClick={() => respond(perm, "always")}>Always</Button>
                        <Button variant="ghost" size="sm" className="oc-deny" onClick={() => respond(perm, "reject")}>Deny</Button>
                      </div>
                    </div>
                  </MessageScrollerItem>
                ))}
                {error && boot && (
                  <div className={"oc-notice" + (error.kind === "stopped" ? " quiet" : "")}>
                    <span>{error.kind === "stopped" ? "■ stopped" : error.text}</span>
                    <button className="oc-notice-x" title="Dismiss" onClick={() => setError(null)}>×</button>
                  </div>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      </div>

      <div className="oc-status">
        <span className={"oc-status-inner" + (busy && !visiblePerms.length ? " on" : "")}>
          <AsciiLoader cols={12} rows={1} /> <span className="oc-shimmer mono">working…</span>
        </span>
        <span className="spacer" />
        {diff.length > 0 && (
          <span className="oc-diff">
            {diffOpen && (
              <span className="oc-diff-pop">
                {diff.map((d) => (
                  <span key={d.file} className="oc-diff-row mono">
                    <span className="oc-diff-file">{d.file.split("/").slice(-2).join("/")}</span>
                    <span className="ok">+{d.additions}</span> <span className="bad">−{d.deletions}</span>
                  </span>
                ))}
              </span>
            )}
            <button className="oc-diff-chip mono" onClick={() => setDiffOpen((o) => !o)}>
              {diff.length} file{diff.length === 1 ? "" : "s"} changed
              <span className="ok"> +{diff.reduce((n, d) => n + d.additions, 0)}</span>
              <span className="bad"> −{diff.reduce((n, d) => n + d.deletions, 0)}</span>
            </button>
          </span>
        )}
      </div>

      <div className="chat-composer">
        {palette && (
          <div className="oc-palette">
            {palette.items.map((it, i) => (
              <button
                key={it.key}
                data-on={i === palIndex ? "1" : "0"}
                onMouseEnter={() => setPalIndex(i)}
                onClick={() => it.run()}
              >
                <span className="mono">{it.label}</span>
                <span className="oc-cmd-desc">{it.desc}</span>
              </button>
            ))}
          </div>
        )}
        <div className="oc-card">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 140) + "px";
            }}
            onKeyDown={onKey}
            placeholder={busy ? "working… (you can queue the next message)" : `Ask or change ${project}…`}
            className="oc-ta"
            autoFocus
          />
          <div className="oc-card-row">
            <button
              className="oc-plus"
              title={'Commands ("/")'}
              onClick={() => { setInput("/"); inputRef.current?.focus({ preventScroll: true }); }}
            ><Plus /></button>
            <button className="oc-send" title="Send" onClick={() => send()} disabled={!input.trim()}><ArrowUp /></button>
          </div>
        </div>
        <div className="chat-model oc-model-row">
          {boot.models.length > 0 && (
            <Select
              value={modelKey ?? ""}
              onValueChange={(v) => {
                if (v === "__all") { setInput("/models "); inputRef.current?.focus({ preventScroll: true }); return; }
                chooseModel(v);
              }}
            >
              <SelectTrigger size="sm" className="oc-model-trigger" aria-label="Model">
                <SelectValue placeholder="model">
                  {selModel ? `${selModel.name}${selModel.free ? " · free" : ""}` : "model"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {shortModels.map((m) => (
                  <SelectItem key={`${m.providerID}:${m.modelID}`} value={`${m.providerID}:${m.modelID}`}>
                    {m.name}{m.free ? " · free" : ""} <span className="oc-ago">{m.provider}</span>
                  </SelectItem>
                ))}
                <SelectItem value="__all">All models… <span className="oc-ago">/models</span></SelectItem>
              </SelectContent>
            </Select>
          )}
          {agentName && <span className="oc-agent mono" title="Active agent (set via /agents)">{agentName}</span>}
        </div>
      </div>
    </>
  );
}
