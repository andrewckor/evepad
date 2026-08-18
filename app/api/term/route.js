// Control plane for embedded terminals: start, stop, keyboard input, resize.

import { resolveProject } from "../../../lib/projects.js";
// Imported lazily: terminals need node-pty, an optional dependency that has no
// Linux prebuild. A missing pty must degrade to "terminals unavailable", not
// take down the routes that merely sit next to it.
const terminals = () => import("../../../lib/terminals.js");

export async function POST(request) {
  let startTerm, stopTerm, getTerm;
  try {
    ({ startTerm, stopTerm, getTerm } = await terminals());
  } catch {
    return Response.json(
      { error: "Terminals need node-pty, which isn't installed for this platform." },
      { status: 501 },
    );
  }

  const body = await request.json();
  const { project: name, action, data, cols, rows, variant } = body;

  if (action === "start") {
    // The login terminal isn't a project's — and it's exactly the terminal you
    // need when resolveProject() can't work, because the credential that lists
    // projects is the thing that's broken.
    const project = variant === "login" ? { name: "__login" }
      // Creating: there is no project yet — the name and the folder the user
      // picked ARE the input.
      : variant === "create" ? { name, localPath: body.dir, model: body.model }
      : await resolveProject(name);
    if (!project) return Response.json({ error: "unknown project" }, { status: 404 });
    try {
      const term = await startTerm(project, variant, { cols, rows });
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
