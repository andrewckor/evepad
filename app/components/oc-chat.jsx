"use client";

// Custom OpenCode client — our components, their engine. Renders from
// /api/oc/messages hydration plus the /api/oc/events NDJSON stream; every
// action (prompt, slash command, abort, permission reply, new session) is a
// thin POST to /api/oc/act. Command parity comes from the server's own
// registry, so /undo, /models, /compact and custom commands all work here
// without reimplementation.

import { useState, useRef, useEffect, useCallback } from "react";
import { Streamdown } from "streamdown";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";

const fetchJson = async (url, opts) => {
  const r = await fetch(url, opts);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? "request failed");
  return body;
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

  const [boot, setBoot] = useState(null); // {sessions, commands, models, defaults}
  const [sessionId, setSessionId] = useState(null);
  const sessionRef = useRef(null);
  sessionRef.current = sessionId;
  const [busy, setBusy] = useState(false);
  const [perms, setPerms] = useState([]); // pending permission asks
  const [error, setError] = useState(null);
  const [input, setInput] = useState("");
  const [modelKey, setModelKey] = useState(null);
  const [agentName, setAgentName] = useState(null); // null = server default
  const [palIndex, setPalIndex] = useState(0);
  const scroller = useRef(null);
  const inputRef = useRef(null);
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;

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
        const saved = sessionStorage.getItem(`oc-session:${project}`);
        const pick = b.sessions.find((s) => s.id === saved) ?? b.sessions[0];
        setSessionId(pick?.id ?? null);
        const savedModel = sessionStorage.getItem("build-model");
        const m = b.models.find((x) => `${x.providerID}:${x.modelID}` === savedModel)
          ?? b.models.find((x) => x.default) ?? b.models[0];
        if (m) setModelKey(`${m.providerID}:${m.modelID}`);
      })
      .catch((e) => !stale && setError(e.message));
    return () => { stale = true; };
  }, [project]);

  // ---- hydrate transcript on session switch
  useEffect(() => {
    if (!sessionId) { store.current = new Map(); bump(); return; }
    sessionStorage.setItem(`oc-session:${project}`, sessionId);
    let stale = false;
    fetchJson(`/api/oc/messages?project=${encodeURIComponent(project)}&session=${sessionId}`)
      .then(({ messages }) => {
        if (stale) return;
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
      .catch((e) => !stale && setError(e.message));
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
          bump();
          return;
        }
        case "message.part.delta": {
          if (p.sessionID !== sid) return;
          const part = store.current.get(p.messageID)?.parts.get(p.partID);
          if (part && p.field === "text") { part.text = (part.text ?? "") + p.delta; bump(); }
          return;
        }
        case "session.status": {
          if (p.sessionID !== sid) return;
          const t = p.status?.type ?? p.type;
          setBusy(t !== "idle");
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
          setError(String(p.error?.data?.message ?? p.error?.name ?? "session error").slice(0, 300));
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

  // ---- autoscroll
  const msgs = [...store.current.values()].sort((a, b) => String(a.info.id).localeCompare(String(b.info.id)));
  useEffect(() => {
    scroller.current?.scrollTo(0, scroller.current.scrollHeight);
  });

  // ---- actions
  const selModel = boot?.models.find((m) => `${m.providerID}:${m.modelID}` === modelKey);
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
    } catch (e) { setError(e.message); setBusy(false); }
  };

  // Graph buttons (and anything else in the cockpit) can hand us text.
  useEffect(() => {
    const h = (e) => {
      const { text, submit } = e.detail ?? {};
      if (!text) return;
      if (submit) send(text);
      else { setInput(text); inputRef.current?.focus(); }
    };
    window.addEventListener("oc:send", h);
    return () => window.removeEventListener("oc:send", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot, modelKey, sessionId]);

  const respond = (perm, response) =>
    act({ action: "permission", sessionId: perm.sessionID, permissionId: perm.id, response })
      .then(() => setPerms((ps) => ps.filter((x) => x.id !== perm.id)))
      .catch((e) => setError(e.message));

  // ---- palette: /cmd filters commands; "/models q", "/agents q",
  // "/sessions q" flip into searchable pickers.
  const palette = (() => {
    if (!input.startsWith("/") || !boot) return null;
    const spaceAt = input.indexOf(" ");
    if (spaceAt === -1) {
      const q = input.slice(1);
      const items = allCommands
        .filter((c) => c.name.startsWith(q))
        .slice(0, 9)
        .map((c) => ({ key: c.name, label: `/${c.name}`, desc: c.description, run: () => send(`/${c.name}`) }));
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
          run: () => {
            const k = `${m.providerID}:${m.modelID}`;
            setModelKey(k); sessionStorage.setItem("build-model", k); setInput("");
          },
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
          desc: se.id === sessionId ? "current" : "",
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
    if (e.key === "Enter") send();
  };

  if (error && !boot) return <div className="bad" style={{ padding: 16, fontSize: 13 }}>{error}</div>;
  if (!boot) return <div className="dim mono" style={{ padding: 16, display: "flex", gap: 8 }}><Spinner /> connecting to opencode…</div>;

  return (
    <>
      <div className="oc-head">
        <select
          className="oc-session"
          value={sessionId ?? ""}
          onChange={(e) => setSessionId(e.target.value || null)}
          title="Session"
        >
          {!boot.sessions.length && <option value="">new session</option>}
          {boot.sessions.map((s) => (
            <option key={s.id} value={s.id}>{(s.title ?? s.id).slice(0, 46)}</option>
          ))}
        </select>
        <button
          className="oc-new"
          title="New session"
          onClick={async () => {
            try {
              const created = await act({ action: "new" });
              setBoot((b) => b && { ...b, sessions: [{ id: created.id, title: created.title, updated: Date.now() }, ...b.sessions] });
              setSessionId(created.id);
            } catch (e) { setError(e.message); }
          }}
        >+</button>
        <div className="spacer" />
        {busy && (
          <button className="oc-abort" onClick={() => sessionId && act({ action: "abort", sessionId }).catch(() => {})}>
            stop
          </button>
        )}
      </div>

      <div className="buildchat" ref={scroller}>
        {!msgs.length && (
          <div className="chat-empty">
            <div className="dim">Build chat for <b>{project}</b> — OpenCode under the hood, cockpit UI on top.
              Ask, change code, or type <span className="mono">/</span> for commands (<span className="mono">/undo</span>,
              <span className="mono"> /redo</span>, <span className="mono">/compact</span>…).</div>
          </div>
        )}
        {msgs.map((m) => {
          const parts = [...m.parts.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
          return (
            <div key={m.info.id} className={"bmsg " + (m.info.role === "user" ? "user" : "assistant")}>
              {parts.map((p) => {
                if (p.type === "text") {
                  return m.info.role === "user"
                    ? <div key={p.id} className="bmsg-user">{p.text}</div>
                    : (p.text?.trim() ? <Streamdown key={p.id} className="chat-md">{p.text}</Streamdown> : null);
                }
                if (p.type === "tool") {
                  const st = p.state?.status;
                  return (
                    <div key={p.id} className={"msg-tool mono oc-" + (st ?? "pending")}>
                      {st === "completed" ? "✓" : st === "error" ? "✗" : <Spinner className="oc-spin" />} {p.tool} <span className="dim2">{partLabel(p)}</span>
                    </div>
                  );
                }
                if (p.type === "reasoning") return null;
                return null;
              })}
            </div>
          );
        })}
        {perms.filter((perm) => perm.sessionID === sessionId).map((perm) => (
          <div key={perm.id} className="oc-perm">
            <div className="oc-perm-title mono">{perm.permission ?? perm.type}: {perm.metadata?.command ?? (perm.patterns ?? []).join(", ") ?? perm.title}</div>
            <div className="oc-perm-actions">
              <Button variant="outline" size="sm" onClick={() => respond(perm, "once")}>Allow once</Button>
              <Button variant="outline" size="sm" onClick={() => respond(perm, "always")}>Always</Button>
              <Button variant="ghost" size="sm" className="oc-deny" onClick={() => respond(perm, "reject")}>Deny</Button>
            </div>
          </div>
        ))}
        {busy && !perms.length && (
          <div className="dim mono" style={{ display: "flex", gap: 8, alignItems: "center" }}><Spinner /> working…</div>
        )}
        {error && boot && <div className="bad" style={{ fontSize: 13 }}>{error}</div>}
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
        <div className="chat-input">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder={busy ? "working… (you can queue the next message)" : `Ask or change ${project}… ("/" for commands)`}
            autoFocus
          />
          <button onClick={() => send()} disabled={!input.trim()}>↩</button>
        </div>
        {boot.models.length > 0 && (
          <div className="chat-model">
            <select
              value={modelKey ?? ""}
              onChange={(e) => { setModelKey(e.target.value); sessionStorage.setItem("build-model", e.target.value); }}
              aria-label="Model"
            >
              {[...new Set(boot.models.map((m) => m.provider))].map((prov) => (
                <optgroup key={prov} label={prov}>
                  {boot.models.filter((m) => m.provider === prov).map((m) => (
                    <option key={`${m.providerID}:${m.modelID}`} value={`${m.providerID}:${m.modelID}`}>
                      {m.name}{m.free ? " · free" : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {agentName && <span className="oc-agent mono" title="Active agent (set via /agents)">{agentName}</span>}
          </div>
        )}
      </div>
    </>
  );
}
