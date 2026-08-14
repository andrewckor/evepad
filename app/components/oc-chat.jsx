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
        setPerms([]);
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
          if (p.sessionID !== sid) return;
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

  const send = async (raw) => {
    const text = (raw ?? input).trim();
    if (!text) return;
    setInput(""); setError(null);
    try {
      const sid = await ensureSession();
      if (text.startsWith("/")) {
        const [cmd, ...rest] = text.slice(1).split(" ");
        const known = boot?.commands.find((c) => c.name === cmd);
        if (known?.builtin) {
          if (cmd === "compact") setBusy(true);
          await act({ action: cmd, sessionId: sid, provider: selModel?.providerID, model: selModel?.modelID });
          if (cmd !== "compact") {
            // undo/redo change the transcript server-side — rehydrate.
            const { messages } = await fetchJson(`/api/oc/messages?project=${encodeURIComponent(project)}&session=${sid}`);
            const next = new Map();
            for (const m of messages) next.set(m.info.id, { info: m.info, parts: new Map(m.parts.map((p) => [p.id, p])) });
            store.current = next; bump();
          }
          return;
        }
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
      await act({ action: "prompt", sessionId: sid, text, provider: selModel?.providerID, model: selModel?.modelID });
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

  // ---- palette
  const paletteOpen = input.startsWith("/") && !input.includes(" ");
  const filtered = paletteOpen
    ? (boot?.commands ?? []).filter((c) => c.name.startsWith(input.slice(1))).slice(0, 8)
    : [];
  useEffect(() => { setPalIndex(0); }, [input]);

  const onKey = (e) => {
    if (paletteOpen && filtered.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setPalIndex((i) => (i + 1) % filtered.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setPalIndex((i) => (i - 1 + filtered.length) % filtered.length); return; }
      if (e.key === "Tab") { e.preventDefault(); setInput(`/${filtered[palIndex].name} `); return; }
      if (e.key === "Enter") { e.preventDefault(); send(`/${filtered[palIndex].name}`); return; }
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
        {perms.map((perm) => (
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
        {paletteOpen && filtered.length > 0 && (
          <div className="oc-palette">
            {filtered.map((c, i) => (
              <button
                key={c.name}
                data-on={i === palIndex ? "1" : "0"}
                onMouseEnter={() => setPalIndex(i)}
                onClick={() => send(`/${c.name}`)}
              >
                <span className="mono">/{c.name}</span>
                <span className="oc-cmd-desc">{c.description}</span>
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
          </div>
        )}
      </div>
    </>
  );
}
