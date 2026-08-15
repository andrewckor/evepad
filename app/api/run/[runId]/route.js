import { getRun } from "../../../../lib/data.js";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const { runId } = await params;
  const q = new URL(request.url).searchParams;
  try {
    const run = await getRun(runId, {
      project: q.get("project") ?? undefined,
      environment: q.get("environment") ?? "local",
      // fresh=1 skips the live-run cache — used by the stream notifier's
      // refetch so a nudge never returns the pre-nudge snapshot.
      fresh: q.get("fresh") === "1",
    });
    if (!run) return Response.json({ error: "Run not found in this project/environment." }, { status: 404 });
    return Response.json(run);
  } catch (e) {
    return Response.json({ error: String(e.message ?? e) }, { status: 500 });
  }
}
