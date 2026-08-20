// Session controls for a locally running eve agent, proxied like /api/chat.
// cancel: POST /eve/v1/session/:id/cancel — stops the in-flight turn, the
//         session stays alive.
// reset:  POST /eve/v1/session/:id/reset — TERMINATES the backing workflow;
//         the session id is dead afterwards and the next message starts a
//         fresh run.

import { resolveProject } from "@/lib/projects";

const PORT_RE = /^\d{4,5}$/;
const SID_RE = /^[A-Za-z0-9_-]{10,80}$/;
const ACTIONS = new Set(["cancel", "reset"]);

export async function POST(request: Request) {
  const { port, project, sessionId, action } = await request.json();
  // The run detail page knows the project, not the port — resolve it here.
  let p = port;
  if (!p && typeof project === "string") p = (await resolveProject(project))?.localPort;
  if (!PORT_RE.test(String(p))) return Response.json({ error: "bad port" }, { status: 400 });
  if (!SID_RE.test(String(sessionId)))
    return Response.json({ error: "bad session id" }, { status: 400 });
  if (!ACTIONS.has(action)) return Response.json({ error: "bad action" }, { status: 400 });

  try {
    const r = await fetch(
      `http://127.0.0.1:${p}/eve/v1/session/${encodeURIComponent(sessionId)}/${action}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    return Response.json(await r.json(), { status: r.status });
  } catch {
    return Response.json({ error: `No eve server answering on :${p}` }, { status: 502 });
  }
}
