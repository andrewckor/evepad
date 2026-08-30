// The agents collection: what this machine knows about locally.
//
// Creating one is NOT a request here — `eve init`, `vercel link` and `env pull`
// run in a visible terminal (the "create" variant in lib/terminals.js), because
// they take about a minute and a silent POST for that long is indistinguishable
// from a hang. POST is the last step of that flow: verify what the terminal
// actually produced, then register it.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { remember, forget } from "@/lib/registry";
import { invalidateVercelProjects } from "@/lib/projects";
import { purgeSessions } from "@/lib/opencode";
import { isAgentName } from "@/lib/agent-name";

// Would `dir/name` collide? The dialog asks while you type, so the collision
// shows up as a hint next to the name instead of a dead terminal after Create.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const name = url.searchParams.get("name");
  const dir = url.searchParams.get("dir");
  // isAgentName also guards the join: traversal names never reach it.
  if (!name || !dir || !isAgentName(name)) return Response.json({ exists: false });
  return Response.json({ exists: existsSync(join(dir, name)) });
}

export async function POST(request: Request) {
  const { name, dir } = await request.json();
  if (!isAgentName(name)) return Response.json({ error: "Invalid agent name." }, { status: 400 });
  if (!dir) return Response.json({ error: "No folder." }, { status: 400 });

  const path = join(dir, name);
  // Trust the filesystem, not an exit code: this is what the terminal actually
  // left behind.
  if (!existsSync(join(path, "package.json")))
    return Response.json(
      { error: "The scaffold didn't complete — see the terminal above." },
      { status: 422 },
    );

  remember(name, path);
  // The scaffold just created the Vercel project; the cached remote list
  // predates it, and the redirect to Build resolves the project immediately.
  invalidateVercelProjects();
  // Chat histories are keyed by worktree in opencode's global store, so a
  // fresh agent at a reused path would inherit a dead agent's sessions.
  try {
    await purgeSessions(path);
  } catch {}
  return Response.json({ ok: true, name, path });
}

// Forget a checkout. The folder stays on disk — this only drops the mapping,
// which is what you want when an agent moves or you stop working on it.
export async function DELETE(request: Request) {
  const name = new URL(request.url).searchParams.get("name");
  if (!name) return Response.json({ error: "no agent" }, { status: 400 });
  return Response.json({ ok: forget(name) });
}
