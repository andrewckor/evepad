// Everything the custom OpenCode UI needs to boot: sessions for this
// checkout, the command registry, the model catalog, and defaults.

import { resolveProject, identityTag } from "../../../../lib/projects.js";
import { ocClient, listModels, DEFAULTS } from "../../../../lib/opencode.js";

export const dynamic = "force-dynamic";

// Boot data changes slowly (sessions list, commands, models, agents) — serve
// the last snapshot instantly and refresh behind, so opening Build or
// switching projects never blocks on four upstream calls.
const cache = new Map(); // name -> {at, data}
const TTL = 15_000;

export async function GET(request) {
  const name = new URL(request.url).searchParams.get("project") ?? "";
  const project = await resolveProject(name);
  if (!project?.localPath) return Response.json({ error: "No local checkout." }, { status: 409 });
  const hit = cache.get(project.name);
  if (hit && Date.now() - hit.at < TTL) return Response.json(hit.data);
  if (hit) {
    // stale: refresh in the background, serve instantly
    build(project).then((data) => cache.set(project.name, { at: Date.now(), data })).catch(() => {});
    return Response.json(hit.data);
  }
  try {
    const data = await build(project);
    cache.set(project.name, { at: Date.now(), data });
    return Response.json(data);
  } catch (e) {
    return Response.json({ error: String(e.message ?? e).slice(0, 250) }, { status: 502 });
  }
}

async function build(project) {
  {
    const { client, dir } = await ocClient(project.localPath);
    const [sessions, commands, models, agents] = await Promise.all([
      client.session.list({ query: { directory: dir }, throwOnError: true }),
      client.command.list({ query: { directory: dir }, throwOnError: true }),
      listModels(project),
      client.app.agents({ query: { directory: dir }, throwOnError: true }),
    ]);
    return ({
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
    });
  }
}
