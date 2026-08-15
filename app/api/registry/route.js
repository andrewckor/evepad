// The local-checkout registry: which agent lives in which folder on this
// machine. Linking happens through /api/dev (it opens the folder picker);
// this route only forgets, which is what you need when a folder moves.

import { forget } from "../../../lib/registry.js";

export async function POST(request) {
  const { project, action } = await request.json();
  if (action !== "forget") return Response.json({ error: "unknown action" }, { status: 400 });
  if (!project) return Response.json({ error: "no project" }, { status: 400 });
  return Response.json({ ok: forget(project) });
}
