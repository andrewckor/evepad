# evepad

A local dashboard + build harness for [eve](https://vercel.com/docs/eve) agents —
"a v0 for eve". One surface for the whole loop: create an agent, generate and
edit its tools by chat (OpenCode under the hood, GLM via the AI Gateway),
watch the agent graph update live, run it, and inspect every run — local and
production side by side.

## Requirements

- **Node 20+** (developed on Node 24)
- **macOS** is the developed-and-tested platform. It runs on Linux, with two
  caveats: the folder picker is Mac-only, and the embedded terminals need
  `node-pty`, which has no Linux prebuild — it compiles with node-gyp
  (`python3`, `make`, `g++`) and is an *optional* dependency, so without those
  the app still installs and runs, just without terminals. Headless hosts skip
  the browser open and print the URL.

That's all. The Vercel CLI is used for sign-in, project linking and env pulls,
but it doesn't have to be installed — without it, every call runs through
`npx vercel` instead. Sign in from the app's first-run screen.

## Run

```bash
npx evepad
```

Opens http://127.0.0.1:4680. The published package ships the app prebuilt, so
this starts a server rather than building one — nothing compiles on your
machine. `npm i -g evepad` if you use it often; `evepad --port 4681` to move
it. Everything else boots lazily on first use (the OpenCode server per
project, terminals, event hubs).

Install it as a PWA from the browser (Chrome: Install evepad, Safari: Add to
Dock) and it gets its own window and Dock icon.

## Develop

```bash
npm install
npm run dev          # http://127.0.0.1:5173
node scripts/pack.mjs # build + assemble the publishable package into dist/
```

## Connect your agents

- **Existing checkout**: pick the project in the top-left dropdown and press
  the 📁 button to point evepad at its folder. Press ▶ to start
  `eve dev` for it.
- **New agent**: from the Agents homepage, "New agent" scaffolds `eve init`,
  links a Vercel project, pulls env, and starts the dev server — all behind
  the scenes (checkouts live in `~/eve-agents`).
- **Remote runs**: production/preview runs of linked Vercel projects appear
  automatically; the environment filter is global across the app.

## The surfaces

- **Agents** (`/`) — every project as a card, with live status.
- **Agent Runs** (`/runs`) — the Vercel-style dashboard: charts, filters,
  run table, streaming run detail.
- **Build** (`/build`) — chat with a real coding agent scoped to the
  checkout's agent surface, beside a live React Flow graph of tools,
  schedules (with human-readable cadence), channels and connections.
  Type `/` for the command palette (`/models`, `/undo`, `/compact`,
  `/sessions`, custom opencode commands). Bash calls ask for approval
  in-chat.
- **Terminal / Chat panels** — dockable `eve dev` TUI and a direct chat
  with the running agent.

## Notes

- The Build engine is a per-project [OpenCode](https://opencode.ai) server
  (`@opencode-ai/sdk`), booted with that project's `VERCEL_OIDC_TOKEN` so
  AI Gateway models (GLM 5.2 by default) authenticate with the project's
  own credentials. Tokens auto-refresh via `vercel env pull`.
- `workflow` is pinned to the 5.x beta line eve vendors — the 4.x client
  silently returns empty lists against 5.x agents.
- Design north star: indistinguishable from Vercel's own dashboard
  (Geist, measured values, `vercel-geist-icons` only). See `AGENTS.md`.

## Notices

evepad is a community project — not affiliated with, endorsed by, or sponsored
by Vercel. "eve" and "Vercel" are trademarks of Vercel, Inc.

The pixel-grid loader (and the app icon derived from it) follows the Loading
State component from [beautifului.dev](https://www.beautifului.dev/).
