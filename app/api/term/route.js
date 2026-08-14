// Control plane for embedded terminals: start, stop, keyboard input, resize.

import { resolveProject } from "../../../lib/projects.js";
import { startTerm, stopTerm, getTerm } from "../../../lib/terminals.js";

export async function POST(request) {
  const { project: name, action, data, cols, rows, variant } = await request.json();

  if (action === "start") {
    const project = await resolveProject(name);
    if (!project) return Response.json({ error: "unknown project" }, { status: 404 });
    try {
      const term = await startTerm(project, variant);
      return Response.json({ ok: true, mode: term.mode, port: term.port });
    } catch (e) {
      return Response.json({ error: String(e.message ?? e) }, { status: 409 });
    }
  }

  const term = getTerm(name, variant);
  if (!term) return Response.json({ error: "no terminal for this project" }, { status: 404 });

  if (action === "input") {
    if (typeof data === "string") term.pty.write(data);
    return Response.json({ ok: true });
  }
  if (action === "resize") {
    const c = Math.max(20, Math.min(500, Number(cols) || 0));
    const r = Math.max(5, Math.min(200, Number(rows) || 0));
    if (c && r) try { term.pty.resize(c, r); } catch {}
    return Response.json({ ok: true });
  }
  if (action === "stop") {
    stopTerm(name, variant);
    return Response.json({ ok: true });
  }

  return Response.json({ error: "action must be start, stop, input, or resize" }, { status: 400 });
}
