// Models the Build chat can use, from the running OpenCode server's provider
// registry (Vercel AI Gateway first — free via the project's own creds).

import { resolveProject } from "../../../lib/projects.js";
import { listModels } from "../../../lib/opencode.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const name = new URL(request.url).searchParams.get("project") ?? "";
  const project = await resolveProject(name);
  if (!project?.localPath) return Response.json({ error: "No local checkout." }, { status: 409 });
  try {
    return Response.json({ models: await listModels(project) });
  } catch (e) {
    return Response.json({ error: String(e.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
