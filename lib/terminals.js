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
import { join } from "node:path";
import { freshOidc, opencodeServerUrl } from "./opencode.js";

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

const termKey = (name, variant) => (variant === "opencode" ? `${name}:opencode` : name);

export function getTerm(name, variant) {
  return terms.get(termKey(name, variant)) ?? null;
}

export async function startTerm(project, variant = "eve") {
  const key = termKey(project.name, variant);
  const existing = terms.get(key);
  if (existing && !existing.exited) {
    // An opencode TUI is only alive if the server it attached to still is —
    // after a server reboot the old pty renders fine but every prompt fails
    // with "Unable to connect". Respawn against the current server.
    if (variant === "opencode" && project.localPath) {
      const url = await opencodeServerUrl(project.localPath);
      if (existing.serverUrl === url) return existing;
      try { existing.pty.kill(); } catch {}
      terms.delete(key);
    } else {
      return existing;
    }
  }

  if (!project.localPath) throw new Error("no known checkout for this project");

  let cmd, args, port = null, mode;
  const env = { ...process.env, TERM: "xterm-256color" };
  if (variant === "opencode") {
    // The real OpenCode TUI on the checkout, defaulted to the AI Gateway so
    // it codes on the project's own creds (GLM free) out of the box.
    cmd = join(process.cwd(), "node_modules", ".bin", "opencode");
    // Attach the TUI to the cockpit's shared OpenCode server: same sessions as
    // Build chat, and the cockpit can inject prompts via tui.appendPrompt.
    const url = await opencodeServerUrl(project.localPath);
    args = ["attach", url, "--dir", project.localPath];
    mode = "opencode";
    const oidc = await freshOidc(project.localPath);
    if (oidc) env.VERCEL_OIDC_TOKEN = oidc;
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      model: "vercel/zai/glm-5.2",
      provider: {
        vercel: {
          npm: "@ai-sdk/gateway",
          name: "Vercel AI Gateway",
          models: { "zai/glm-5.2": { name: "GLM 5.2" }, "zai/glm-5.2-fast": { name: "GLM 5.2 Fast" } },
        },
      },
    });
    env.PATH = `${join(process.cwd(), "node_modules", ".bin")}:${env.PATH ?? ""}`;
  } else {
    cmd = "npm";
    port = project.live ? project.localPort : await freePort();
    args = project.live
      ? ["exec", "--", "eve", "dev", `http://127.0.0.1:${port}`]
      : ["exec", "--", "eve", "dev", "--port", String(port)];
    mode = project.live ? "attach" : "full";
    env.EVE_TRACES_CONTENT = "on";
  }

  const pty = ptySpawn(cmd, args, {
    name: "xterm-256color",
    cols: 120,
    rows: 32,
    cwd: project.localPath,
    env,
  });

  const term = {
    name: project.name,
    pty,
    port,
    mode,
    serverUrl: variant === "opencode" ? args[1] : null,
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

  terms.set(key, term);
  return term;
}

export function stopTerm(name, variant) {
  const term = terms.get(termKey(name, variant));
  if (!term) return false;
  try { term.pty.kill(); } catch {}
  terms.delete(termKey(name, variant));
  return true;
}
