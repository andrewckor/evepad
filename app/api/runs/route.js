import { listRuns, DEFAULT_PERIOD } from "../../../lib/data.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const q = new URL(request.url).searchParams;
  const data = await listRuns({
    project: q.get("project") ?? undefined,
    environment: q.get("environment") ?? "local",
    period: q.get("period") ?? DEFAULT_PERIOD,
    limit: Number(q.get("limit") ?? 100),
  });
  return Response.json(data);
}
