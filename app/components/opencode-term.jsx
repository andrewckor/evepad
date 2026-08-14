"use client";

// The Build page's chat surface IS the OpenCode TUI: a pty running
// `opencode attach` against the cockpit's shared server, --dir'd to the
// checkout, model preset to GLM via the AI Gateway. xterm renders it; the
// graph's action buttons inject prompts through the same pty.

import { useEffect, useRef, useState } from "react";

export function sendToOpencode(project, text, { submit = true } = {}) {
  return fetch("/api/term", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project,
      action: "input",
      variant: "opencode",
      data: submit ? text + "\r" : text,
    }),
  });
}

export default function OpencodeTerm({ project }) {
  const mount = useRef(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let disposed = false;
    let xterm, fit, abort, ro;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      await import("@xterm/xterm/css/xterm.css");
      if (disposed) return;

      const start = await fetch("/api/term", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, action: "start", variant: "opencode" }),
      });
      const info = await start.json();
      if (!start.ok) { setError(info.error ?? "failed to start opencode"); return; }
      if (disposed) return;

      xterm = new Terminal({
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12.5,
        theme: { background: "#000000", foreground: "#ededed", cursor: "#0072f5" },
        cursorBlink: true,
        scrollback: 4000,
      });
      fit = new FitAddon();
      xterm.loadAddon(fit);
      xterm.open(mount.current);
      fit.fit();
      xterm.focus();

      const post = (body) =>
        fetch("/api/term", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project, variant: "opencode", ...body }),
        });
      post({ action: "resize", cols: xterm.cols, rows: xterm.rows });
      ro = new ResizeObserver(() => {
        fit.fit();
        post({ action: "resize", cols: xterm.cols, rows: xterm.rows });
      });
      ro.observe(mount.current);
      xterm.onData((data) => post({ action: "input", data }));

      abort = new AbortController();
      const res = await fetch(
        `/api/term/stream?project=${encodeURIComponent(project)}&variant=opencode`,
        { signal: abort.signal },
      );
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || disposed) break;
        xterm.write(value);
      }
    })().catch(() => {});

    return () => {
      disposed = true;
      ro?.disconnect();
      abort?.abort();
      xterm?.dispose();
    };
  }, [project]);

  if (error) return <div className="bad" style={{ padding: 16, fontSize: 13 }}>{error}</div>;
  return <div className="octerm" ref={mount} />;
}
