import { getRun } from "../../../../lib/data.js";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const { runId } = await params;
  const q = new URL(request.url).searchParams;
  try {
    const run = await getRun(runId, {
      project: q.get("project") ?? undefined,
      environment: q.get("environment") ?? "local",
    });
    if (!run) return new Response("not found", { status: 404 });
    return Response.json(run);
  } catch (e) {
    return Response.json({ error: String(e.message ?? e) }, { status: 500 });
  }
}
