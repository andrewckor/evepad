"use client";

// THE xterm mount. A pty on the server, xterm.js in the browser, one wiring:
// dynamic import (xterm touches `window` at import time), theme handed over on
// every data-theme change (it paints to a canvas and can't read CSS variables),
// fit-on-resize with the new size pushed to the pty, keystrokes posted back,
// and the byte stream piped in.
//
// Extracted when the sign-in terminal arrived. The drawer and the reconnect
// dialog are different chrome around the identical terminal — a second copy of
// this would be a second place for the theme sync or the resize handshake to
// silently stop matching.

import { useEffect, useRef } from "react";

// Reads the live tokens so the terminal matches whatever the rest of the app
// is wearing, instead of a second copy of the palette drifting out of step.
function xtermTheme(): { background: string; foreground: string; cursor: string } {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, fallback: string) => cs.getPropertyValue(n).trim() || fallback;
  return {
    background: v("--term-bg", "#0a0a0a"),
    foreground: v("--fg", "#ededed"),
    cursor: v("--acc", "#0072f5"),
  };
}

function xtermFont(): string {
  const geist = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-geist-mono")
    .trim();
  return geist
    ? `${geist}, ui-monospace, SFMono-Regular, Menlo, monospace`
    : "ui-monospace, SFMono-Regular, Menlo, monospace";
}

export type TermStatus = { error?: string; mode?: string; port?: number | null };

export default function XtermView({
  project,
  variant,
  className = "term-body",
  fontSize = 12.5,
  // Extra fields the server needs to START this pty (the create variant needs
  // the folder). Body-only: never part of the identity of the terminal.
  extra,
  autoFocus = true,
  readOnly = false,
  startAction = "start",
  initialInput,
  onStatus,
  onData,
  transformOutput,
  onExit,
}: {
  project: string;
  variant?: string;
  className?: string;
  fontSize?: number;
  extra?: Record<string, unknown>;
  // Off for terminals the user only watches (a deploy): a dialog that yanks
  // focus into a canvas the moment it opens loses its Escape-to-close.
  autoFocus?: boolean;
  // A watch-only terminal still gets the real pty rendering, but never sends
  // keystrokes back or advertises a blinking input cursor.
  readOnly?: boolean;
  startAction?: "start" | "restart";
  initialInput?: string;
  onStatus?: (info: TermStatus) => void;
  // Every chunk the terminal paints, as text, for a caller that needs to READ
  // the transcript (a deploy reading its own URL) without a second stream.
  onData?: (text: string) => void;
  // Presentation-only normalization for a watch terminal. The eval runner's
  // ballot-X, for example, is calligraphic in Geist Mono; callers can swap
  // that one glyph without changing the pty output or the shared font.
  transformOutput?: (text: string) => string;
  onExit?: () => void;
}) {
  const mount = useRef<HTMLDivElement | null>(null);
  // Held in a ref so changing the callback can't re-run the effect and respawn
  // the terminal underneath the user.
  const cbs = useRef({ onStatus, onData, transformOutput, onExit });
  const sentInitialInput = useRef(false);
  cbs.current = { onStatus, onData, transformOutput, onExit };

  useEffect(() => {
    let disposed = false;
    let xterm: import("@xterm/xterm").Terminal | undefined;
    let fit: import("@xterm/addon-fit").FitAddon | undefined;
    let abort: AbortController | undefined;
    let themeSync: MutationObserver | undefined;
    let resizeSync: ResizeObserver | undefined;
    const body = (fields: Record<string, unknown>) =>
      JSON.stringify({ project, variant, ...extra, ...fields });

    (async () => {
      // xterm touches `window` at import time — load it client-side only.
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/xterm/css/xterm.css"),
      ]);
      if (disposed) return;

      xterm = new Terminal({
        fontFamily: xtermFont(),
        fontSize,
        theme: xtermTheme(),
        cursorBlink: !readOnly,
        disableStdin: readOnly,
        scrollback: 4000,
      });
      themeSync = new MutationObserver(() => {
        xterm!.options.theme = xtermTheme();
      });
      themeSync.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });

      fit = new FitAddon();
      xterm.loadAddon(fit);
      if (!mount.current) return;
      xterm.open(mount.current);
      fit.fit();
      if (autoFocus) xterm.focus();

      // The pty starts AFTER fit, carrying the real size. Starting it first was
      // faster, but it spawned an 80-column process into a ~50-column box: the
      // CLI laid its output out for a width it never had, and xterm reflowed
      // that into mid-word wraps. Resizing afterwards cannot re-wrap text that
      // has already been printed.
      const start = await fetch("/api/term", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body({ action: startAction, cols: xterm.cols, rows: xterm.rows }),
      });
      const info = await start.json();
      if (disposed) return;
      if (!start.ok) {
        cbs.current.onStatus?.({ error: info.error ?? "failed to start" });
        return;
      }
      cbs.current.onStatus?.(info);

      if (initialInput && !sentInitialInput.current) {
        sentInitialInput.current = true;
        const sendInput = (data: string) =>
          fetch("/api/term", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: body({ action: "input", data }),
          });
        // Let Escape finish dismissing an existing picker before submitting
        // `/add`; sending them as one terminal write races the TUI transition.
        setTimeout(() => {
          if (disposed) return;
          if (initialInput === "reset-add" || initialInput === "open-channels") {
            void sendInput("\x1b");
            setTimeout(() => {
              if (disposed) return;
              void sendInput("/add\r");
              if (initialInput === "open-channels") {
                setTimeout(() => {
                  if (!disposed) void sendInput("\r");
                }, 650);
              }
            }, 180);
          } else {
            void sendInput(initialInput);
          }
        }, 250);
      }

      const sendResize = () =>
        fetch("/api/term", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body({ action: "resize", cols: xterm!.cols, rows: xterm!.rows }),
        });
      sendResize();
      resizeSync = new ResizeObserver(() => {
        fit!.fit();
        sendResize();
      });
      resizeSync.observe(mount.current);

      if (!readOnly)
        xterm.onData((data) =>
          fetch("/api/term", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: body({ action: "input", data }),
          }),
        );

      abort = new AbortController();
      const qs = new URLSearchParams({ project });
      if (variant) qs.set("variant", variant);
      const res = await fetch(`/api/term/stream?${qs}`, { signal: abort.signal });
      if (!res.ok || !res.body) throw new Error("Unable to connect to the terminal.");
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || disposed) break;
          const text = dec.decode(value, { stream: true });
          xterm!.write(cbs.current.transformOutput?.(text) ?? text);
          cbs.current.onData?.(text);
        }
        if (!disposed) cbs.current.onExit?.();
      })().catch((error) => {
        if (!disposed)
          cbs.current.onStatus?.({
            error: error instanceof Error ? error.message : "Unable to read terminal output.",
          });
      }); // closing the panel aborts the read — expected
    })().catch((error) => {
      if (!disposed)
        cbs.current.onStatus?.({
          error: error instanceof Error ? error.message : "Unable to start the terminal.",
        });
    }); // teardown aborts the stream mid-await — expected

    return () => {
      themeSync?.disconnect();
      resizeSync?.disconnect();
      disposed = true;
      abort?.abort();
      xterm?.dispose();
    };
    // `extra` is deliberately not a dependency: it feeds the START body only,
    // and a terminal's identity must not respawn because a body field changed.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [project, variant, fontSize, readOnly, startAction]);

  return <div className={className} ref={mount} />;
}
