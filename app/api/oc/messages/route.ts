// Full transcript of one session, in the same {info, parts} shape the event
// stream patches — the UI hydrates from here, then applies live events.

import { resolveProject } from "@/lib/projects";
import { ocClient } from "@/lib/opencode";
import { errMsg } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const name = url.searchParams.get("project") ?? "";
  const sessionId = url.searchParams.get("session") ?? "";
  const project = await resolveProject(name);
  if (!project?.localPath) return Response.json({ error: "No local checkout." }, { status: 409 });
  if (!sessionId) return Response.json({ error: "session required" }, { status: 400 });
  try {
    const { client, dir } = await ocClient(project.localPath);
    const res = await client.session.messages({
      path: { id: sessionId },
      query: { directory: dir },
      throwOnError: true,
    });
    return Response.json({ messages: res.data });
  } catch (e) {
    return Response.json({ error: errMsg(e).slice(0, 250) }, { status: 502 });
  }
}
