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
import { homedir } from "node:os";
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

// `login` is the one terminal that isn't a project's: it signs the MACHINE in,
// so it gets a fixed key rather than one derived from whichever page opened it.
// Same bounds the resize action enforces — a size arriving from the client is
// still client input.
const clampDim = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback;
};

const termKey = (name, variant) =>
  variant === "login" ? "__login"
  : variant === "opencode" ? `${name}:opencode`
  : name;

export function getTerm(name, variant) {
  return terms.get(termKey(name, variant)) ?? null;
}

// Scrollback + fan-out, identical for every terminal we spawn. Factored out
// when the login variant arrived rather than copied: two copies of a ring
// buffer is two places for the byte accounting to drift.
function makeTerm({ name, pty, port, mode, serverUrl, filter }) {
  const term = {
    name, pty, port, mode, serverUrl,
    scrollback: [],
    scrollbackBytes: 0,
    subscribers: new Set(),
    exited: false,
  };

  pty.onData((raw) => {
    const data = filter ? filter(raw) : raw;
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

  return term;
}

export async function startTerm(project, variant = "eve", size = {}) {
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

  // The login terminal needs no checkout — it isn't a project's terminal — so
  // it's built before the localPath guard rather than inside the branch below.
  if (variant === "login") {
    const env = { ...process.env, TERM: "xterm-256color" };
    // Deliberately removed: cliToken() prefers VERCEL_TOKEN, so leaving it set
    // means the CLI writes auth.json, the login "succeeds", and the cockpit
    // keeps reading the same rejected env var. Signing in has to be the thing
    // that changes the answer.
    delete env.VERCEL_TOKEN;
    // `vercel login` turns itself non-interactive "when an agent is detected"
    // (its own --non-interactive help text), which skips the GitHub / GitLab /
    // Bitbucket / Email picker and jumps straight to a device URL. Detection
    // reads the environment, and this pty inherits whatever launched the dev
    // server — so a cockpit started from inside an agent session silently gave
    // every user the degraded flow. The sign-in is the user's, not the
    // launcher's; strip the markers so the CLI behaves as it would in their
    // own terminal.
    for (const k of Object.keys(env)) {
      if (/^(CLAUDE|ANTHROPIC)/.test(k)) delete env[k];
    }
    delete env.CI;
    const term = makeTerm({
      name: "__login",
      // `vercel login` directly, not a shell we then type into: the pty is
      // only created when the play button is pressed, so the command IS the
      // consent — and typing into a shell that is still starting races its
      // line editor.
      // Spawned at the VIEW's size, not a guessed 80x14: the CLI wraps its own
      // output, and a process that thinks it has 80 columns inside a 50-column
      // box prints lines that can only be re-wrapped badly.
      pty: ptySpawn("vercel", ["login"], {
        name: "xterm-256color",
        cols: clampDim(size.cols, 20, 500, 80),
        rows: clampDim(size.rows, 5, 200, 14),
        cwd: homedir(), env,
      }),
      port: null,
      mode: "login",
      serverUrl: null,
      // The Vercel CLI prints a Claude Code plugin hint before anything else.
      // It's noise in a box whose whole job is to be legible, so it's dropped —
      // only when the whole tag is in one chunk, since a partial strip would
      // cut an escape sequence in half.
      // The CLI opens with `> <claude-code-hint .../>` — its log prefix and a
      // Claude Code plugin hint on the SAME line. Dropping just the tag left a
      // bare `>` stranded on its own line above the real output, which is what
      // looked misaligned. So: take the whole prefixed line when the hint is
      // all it carried, and use Vercel's own ▲ for the prefix everywhere else.
      filter: (d) => d
        .replace(/(?:\x1b\[\d+m)?>(?:\x1b\[\d+m)? ?<claude-code-hint\b[^>]*\/>[ \t]*\r?\n?/g, "")
        .replace(/<claude-code-hint\b[^>]*\/>[ \t]*\r?\n?/g, "")
        // The captured leading colour code is dropped, not kept: the CLI prints its
        // prefix in dim grey, and the mark should carry the same weight here as
        // it does in the box above.
        .replace(/(^|\r?\n)(?:\x1b\[\d+m)?>((?:\x1b\[\d+m)?) /g, "$1\u25b2$2 ")
        // The CLI puts its prefix on one line and the message, indented, on the
        // next — which reads as a stray glyph floating above the text. Join
        // them so the prefix sits WITH what it prefixes, like a real log line.
        .replace(/(\u25b2(?:\x1b\[\d+m)? )[ \t]*\r?\n[ \t]+/g, "$1"),
    });
    terms.set(key, term);
    return term;
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
    cols: clampDim(size.cols, 20, 500, 120),
    rows: clampDim(size.rows, 5, 200, 32),
    cwd: project.localPath,
    env,
  });

  const term = makeTerm({
    name: project.name,
    pty,
    port,
    mode,
    serverUrl: variant === "opencode" ? args[1] : null,
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
