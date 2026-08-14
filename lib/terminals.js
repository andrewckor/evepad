// PTY session manager: one virtual terminal per project, running the real eve
// dev TUI. The pty map lives on globalThis so Next's dev-mode module reloads
// don't orphan running terminals.
//
// Two modes, picked automatically:
//   attach — a server is already running: `eve dev <url>` opens the TUI against it.
//   full   — nothing running: `eve dev --port <free>` starts server + TUI in one,
//            so opening a terminal IS starting the agent.

import { spawn as ptySpawn } from "node-pty";
import { createServer } from "node:net";

const SCROLLBACK_MAX = 256 * 1024;

const terms = (globalThis.__eveCockpitTerms ??= new Map());

const isFree = (port) =>
  new Promise((res) => {
    const s = createServer()
      .once("error", () => res(false))
      .once("listening", () => s.close(() => res(true)))
      .listen(port, "127.0.0.1");
  });

async function freePort(start = 4200) {
  for (let p = start; p < start + 100; p++) if (await isFree(p)) return p;
  throw new Error("no free port in 4200-4299");
}

export function getTerm(name) {
  return terms.get(name) ?? null;
}

export async function startTerm(project) {
  const existing = terms.get(project.name);
  if (existing && !existing.exited) return existing;

  if (!project.localPath) throw new Error("no known checkout for this project");

  let args;
  let port = project.live ? project.localPort : await freePort();
  if (project.live) {
    args = ["exec", "--", "eve", "dev", `http://127.0.0.1:${port}`];
  } else {
    args = ["exec", "--", "eve", "dev", "--port", String(port)];
  }

  const pty = ptySpawn("npm", args, {
    name: "xterm-256color",
    cols: 120,
    rows: 32,
    cwd: project.localPath,
    env: { ...process.env, EVE_TRACES_CONTENT: "on", TERM: "xterm-256color" },
  });

  const term = {
    name: project.name,
    pty,
    port,
    mode: project.live ? "attach" : "full",
    scrollback: [],
    scrollbackBytes: 0,
    subscribers: new Set(),
    exited: false,
  };

  pty.onData((data) => {
    const buf = Buffer.from(data, "utf8");
    term.scrollback.push(buf);
    term.scrollbackBytes += buf.length;
    while (term.scrollbackBytes > SCROLLBACK_MAX && term.scrollback.length > 1) {
      term.scrollbackBytes -= term.scrollback.shift().length;
    }
    for (const sub of term.subscribers) {
      try { sub.enqueue(buf); } catch {}
    }
  });

  pty.onExit(({ exitCode }) => {
    term.exited = true;
    const bye = Buffer.from(`\r\n\x1b[90m[process exited ${exitCode}]\x1b[0m\r\n`);
    for (const sub of term.subscribers) {
      try { sub.enqueue(bye); sub.close(); } catch {}
    }
    term.subscribers.clear();
  });

  terms.set(project.name, term);
  return term;
}

export function stopTerm(name) {
  const term = terms.get(name);
  if (!term) return false;
  try { term.pty.kill(); } catch {}
  terms.delete(name);
  return true;
}
