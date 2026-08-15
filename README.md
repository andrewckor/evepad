# eve cockpit

A local dashboard + build harness for [eve](https://vercel.com/docs/eve) agents —
"a v0 for eve". One surface for the whole loop: create an agent, generate and
edit its tools by chat (OpenCode under the hood, GLM via the AI Gateway),
watch the agent graph update live, run it, and inspect every run — local and
production side by side.

## Requirements

- **macOS** (the folder picker and Vercel CLI auth path are Mac-specific today)
- **Node 20+** (developed on Node 24)
- **Vercel CLI**, logged in: `npm i -g vercel && vercel login`
  — production/preview runs and AI Gateway credentials ride on this login.

## Run

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5173. Everything else boots lazily on first use
(the OpenCode server per project, terminals, event hubs).

## Connect your agents

- **Existing checkout**: pick the project in the top-left dropdown and press
  the 📁 button to point the cockpit at its folder. Press ▶ to start
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
