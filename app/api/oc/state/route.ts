// Everything the custom OpenCode UI needs to boot: sessions for this
// checkout, the command registry, the model catalog, and defaults.

import { resolveProject, identityTag } from "@/lib/projects";
import { ocClient, listModels, DEFAULTS } from "@/lib/opencode";
import { errMsg } from "@/lib/utils";

export const dynamic = "force-dynamic";

// Boot data changes slowly (sessions list, commands, models, agents) — serve
// the last snapshot instantly and refresh behind, so opening Build or
// switching projects never blocks on four upstream calls.
const cache = new Map(); // name -> {at, data}
const pending = new Map(); // name -> in-flight build promise
const failed = new Map(); // name -> {at, message}
const TTL = 15_000;

// This request NEVER waits on the opencode boot. A cold boot takes seconds,
// and a held connection is one of the browser's six per host — enough of them
// and the next page navigation queues behind this route. So: kick the work
// off, answer {booting:true} immediately, let the client poll.
export async function GET(request: Request) {
  const name = new URL(request.url).searchParams.get("project") ?? "";
  const project = await resolveProject(name);
  if (!project?.localPath) return Response.json({ error: "No local checkout." }, { status: 409 });
  const key = project.name;

  const hit = cache.get(key);
  const fresh = hit && Date.now() - hit.at < TTL;
  if (fresh) return Response.json(hit.data);

  if (!pending.has(key)) {
    const p = build(project)
      .then((data) => {
        cache.set(key, { at: Date.now(), data });
        failed.delete(key);
      })
      .catch((e) => {
        failed.set(key, { at: Date.now(), message: errMsg(e).slice(0, 250) });
      })
      .finally(() => pending.delete(key));
    pending.set(key, p);
  }

  if (hit) return Response.json(hit.data); // stale is better than waiting
  const err = failed.get(key);
  if (err && Date.now() - err.at < 5_000)
    return Response.json({ error: err.message }, { status: 502 });
  return Response.json({ booting: true }, { status: 202 });
}

import type { Project } from "@/lib/types";

async function build(project: Project) {
  {
    const { client, dir } = await ocClient(project.localPath!);
    const [sessions, commands, models, agents] = await Promise.all([
      client.session.list({ query: { directory: dir }, throwOnError: true }),
      client.command.list({ query: { directory: dir }, throwOnError: true }),
      listModels(project),
      client.app.agents({ query: { directory: dir }, throwOnError: true }),
    ]);
    return {
      sessions: sessions.data
        .map((s) => ({ id: s.id, title: s.title, updated: s.time?.updated ?? 0 }))
        .sort((a, b) => b.updated - a.updated)
        .slice(0, 20),
      // Registry commands only — the client prepends TUI-parity built-ins.
      commands: commands.data
        .map((c) => ({ name: c.name, description: c.description ?? "" }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      agents: agents.data
        .filter((a) => a.mode !== "subagent")
        .map((a) => ({ name: a.name, description: a.description ?? "", builtIn: a.builtIn })),
      models,
      defaults: DEFAULTS,
      identity: identityTag(),
    };
  }
}
