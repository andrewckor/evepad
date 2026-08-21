// Run a schedule now on the agent's local dev server. Eve exposes a dev-only
// dispatch route (POST /eve/v1/dev/schedules/:id) — the same path its own cron
// wiring calls, so "run now" exercises exactly what the schedule will do on
// its own. The returned session ids are workflow run ids.

import { resolveProject } from "@/lib/projects";
import { errMsg } from "@/lib/utils";
import { isValidScheduleName, normalizeSessionIds } from "@/lib/schedule-name";

export async function POST(request: Request) {
  const { project: name, schedule } = await request.json();
  if (!isValidScheduleName(schedule))
    return Response.json({ error: "bad schedule name" }, { status: 400 });

  const project = await resolveProject(name);
  if (!project?.localPath || !project.live || !project.localPort)
    return Response.json(
      { error: "The local server isn't running — press play first." },
      { status: 409 },
    );

  try {
    const r = await fetch(
      `http://127.0.0.1:${project.localPort}/eve/v1/dev/schedules/${encodeURIComponent(schedule)}`,
      { method: "POST", signal: AbortSignal.timeout(15_000) },
    );
    const body = await r.json().catch(() => ({}));
    if (!r.ok)
      return Response.json(
        {
          error: String(body.message ?? body.error ?? `dispatch failed (${r.status})`).slice(
            0,
            250,
          ),
        },
        { status: 502 },
      );
    return Response.json({ sessionIds: normalizeSessionIds(body.sessionIds) });
  } catch (e) {
    return Response.json(
      {
        error: /timeout|abort/i.test(errMsg(e))
          ? "The server accepted nothing — dispatch timed out."
          : `No eve server answering on :${project.localPort}`,
      },
      { status: 502 },
    );
  }
}
