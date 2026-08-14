// Everything the custom OpenCode UI needs to boot: sessions for this
// checkout, the command registry, the model catalog, and defaults.

import { resolveProject } from "../../../../lib/projects.js";
import { ocClient, listModels, DEFAULTS } from "../../../../lib/opencode.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const name = new URL(request.url).searchParams.get("project") ?? "";
  const project = await resolveProject(name);
  if (!project?.localPath) return Response.json({ error: "No local checkout." }, { status: 409 });
  try {
    const { client, dir } = await ocClient(project.localPath);
    const [sessions, commands, models] = await Promise.all([
      client.session.list({ query: { directory: dir }, throwOnError: true }),
      client.command.list({ query: { directory: dir }, throwOnError: true }),
      listModels(project),
    ]);
    return Response.json({
      sessions: sessions.data
        .map((s) => ({ id: s.id, title: s.title, updated: s.time?.updated ?? 0 }))
        .sort((a, b) => b.updated - a.updated)
        .slice(0, 20),
      commands: [
        // Built-ins are dedicated endpoints, not registry entries — surface
        // them in the same palette. Handled by /api/oc/act.
        { name: "undo", description: "Revert the last assistant changes", builtin: true },
        { name: "redo", description: "Restore reverted changes", builtin: true },
        { name: "compact", description: "Summarize the session to shrink context", builtin: true },
        ...commands.data
          .map((c) => ({ name: c.name, description: c.description ?? "" }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ],
      models,
      defaults: DEFAULTS,
    });
  } catch (e) {
    return Response.json({ error: String(e.message ?? e).slice(0, 250) }, { status: 502 });
  }
}
