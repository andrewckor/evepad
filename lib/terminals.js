// PTY session manager: one virtual terminal per project, running the real eve
// dev TUI. The pty map lives on globalThis so Next's dev-mode module reloads
// don't orphan running terminals.
//
// Two modes, picked automatically:
//   attach — a server is already running: `eve dev <url>` opens the TUI against it.
//   full   — nothing running: `eve dev --port <free>` starts server + TUI in one,
//            so opening a terminal IS starting the agent.

import { spawn as ptySpawn } from "node-pty";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { homedir } from "node:os";
import { freshOidc, opencodeServerUrl } from "./opencode.js";
import { isAgentName } from "./agent-name.js";
import { workspaceError } from "./settings.js";
import { vercelCommand } from "./vercel-cli.js";

const SCROLLBACK_MAX = 256 * 1024;
const DEFAULT_MODEL = "zai/glm-5.2";

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
  : variant === "create" ? "__create"
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

// The Vercel CLI opens with `> <claude-code-hint .../>` — its log prefix and a
// Claude Code plugin hint on the SAME line. Dropping just the tag strands a
// bare `>` above the real output, so the whole prefixed line goes, and the
// prefix becomes Vercel's own mark everywhere else.
const vercelNoise = (d) => d
  .replace(/(?:\x1b\[\d+m)?>(?:\x1b\[\d+m)? ?<claude-code-hint\b[^>]*\/>[ \t]*\r?\n?/g, "")
  .replace(/<claude-code-hint\b[^>]*\/>[ \t]*\r?\n?/g, "")
  .replace(/(^|\r?\n)(?:\x1b\[\d+m)?>((?:\x1b\[\d+m)?) /g, "$1\u25b2$2 ")
  .replace(/(\u25b2(?:\x1b\[\d+m)? )[ \t]*\r?\n[ \t]+/g, "$1");

// CLIs change behaviour when they detect an agent (the Vercel CLI turns itself
// non-interactive and prints that plugin hint). These ptys are the USER's
// terminal, and inherit whatever launched the dev server — so the markers go.
function userEnv(extra = {}) {
  const env = { ...process.env, TERM: "xterm-256color", ...extra };
  for (const k of Object.keys(env)) {
    if (/^(CLAUDE|ANTHROPIC)/.test(k)) delete env[k];
  }
  delete env.CI;
  return env;
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
    // VERCEL_TOKEN is dropped for login specifically: cliToken() prefers it, so
    // leaving it set means the CLI writes auth.json, the login "succeeds", and
    // evepad keeps reading the same rejected env var.
    const env = userEnv();
    delete env.VERCEL_TOKEN;
    const term = makeTerm({
      name: "__login",
      // `vercel login` directly, not a shell we then type into: the pty is
      // only created when the play button is pressed, so the command IS the
      // consent — and typing into a shell that is still starting races its
      // line editor.
      // Spawned at the VIEW's size, not a guessed 80x14: the CLI wraps its own
      // output, and a process that thinks it has 80 columns inside a 50-column
      // box prints lines that can only be re-wrapped badly.
      pty: ptySpawn(...(([vc, ...pre]) => [vc, [...pre, "login"]])(vercelCommand()), {
        name: "xterm-256color",
        cols: clampDim(size.cols, 20, 500, 80),
        rows: clampDim(size.rows, 5, 200, 14),
        cwd: homedir(), env,
      }),
      port: null,
      mode: "login",
      serverUrl: null,
      filter: vercelNoise,
    });
    terms.set(key, term);
    return term;
  }

  // Scaffolding a NEW agent, run where the user can watch it. Everything here
  // used to happen inside one opaque POST that returned after ~a minute of
  // silence; the commands are the honest progress bar.
  if (variant === "create") {
    if (!isAgentName(project.name)) throw new Error("invalid agent name");
    // The workspace is CREATED here if it doesn't exist. On a fresh machine
    // ~/eve-agents never exists, and the old check turned that into "pick a
    // folder first" — advice that made no sense next to a prefilled path.
    const parent = project.localPath;
    const bad = workspaceError(parent);
    if (bad) throw new Error(bad);
    if (existsSync(join(parent, project.name))) throw new Error(`${project.name} already exists in that folder`);

    const model = project.model && /^[\w./-]+$/.test(project.model) ? project.model : DEFAULT_MODEL;
    const vercel = vercelCommand().join(" ");
    const n = project.name;
    // -e so a failed step stops the chain instead of scaffolding half an agent.
    const script = [
      "set -e",
      // Literal glyphs, not \uXXXX: macOS ships bash 3.2, whose printf leaves
      // \u escapes untouched — the terminal showed "\u25b2 scaffolding…".
      `b(){ printf '\\n\\033[1;35m\u25b2\\033[0m %s\\n' "$1"; }`,
      `k(){ printf '\\033[32m\u2713\\033[0m %s \\033[2m(%ss)\\033[0m\\n' "$1" "$2"; }`,
      `t=$SECONDS; b "scaffolding ${n}\u2026"`,
      `npx --yes eve@latest init ${n} --model ${model}`,
      `k "scaffolded ${n}" $((SECONDS-t))`,
      `cd ${n}`,
      `t=$SECONDS; b "creating Vercel project\u2026"`,
      `${vercel} link --yes --project ${n}`,
      `k "Vercel project created" $((SECONDS-t))`,
      `t=$SECONDS; b "pulling AI Gateway credentials\u2026"`,
      `${vercel} env pull .env.local --yes`,
      `k "credentials pulled" $((SECONDS-t))`,
      `printf '\\n\\033[32m\u2713 ${n} is ready\\033[0m\\n'`,
    ].join("\n");

    const term = makeTerm({
      name: "__create",
      pty: ptySpawn("/bin/bash", ["-lc", script], {
        name: "xterm-256color",
        cols: clampDim(size.cols, 20, 500, 80),
        rows: clampDim(size.rows, 5, 200, 16),
        cwd: parent,
        env: userEnv(),
      }),
      port: null,
      mode: "create",
      serverUrl: null,
      filter: vercelNoise,
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
    // Prefer the checkout-local bin; installed as a package there is no
    // node_modules under cwd, and the launcher puts opencode on PATH instead.
    const localBin = join(process.cwd(), "node_modules", ".bin", "opencode");
    cmd = existsSync(localBin) ? localBin : "opencode";
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
