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
import { isAgentName } from "@/lib/agent-name";

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
  return Response.json({ ok: true, name, path });
}

// Forget a checkout. The folder stays on disk — this only drops the mapping,
// which is what you want when an agent moves or you stop working on it.
export async function DELETE(request: Request) {
  const name = new URL(request.url).searchParams.get("name");
  if (!name) return Response.json({ error: "no agent" }, { status: 400 });
  return Response.json({ ok: forget(name) });
}
