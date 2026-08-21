// Webhook relay for failure alerts. The URL comes from this machine's
// settings — never from the request body, which would let any local page
// turn evepad into a POST cannon. Delivery is best-effort: a dead webhook
// must not break the toast that already fired.

import { getAlertWebhook } from "@/lib/settings";

export async function POST(request: Request) {
  const url = getAlertWebhook();
  if (!url) return Response.json({ delivered: false, note: "No webhook configured." });

  const { project, runId, title } = await request.json().catch(() => ({}));
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `evepad: ${project ?? "agent"} failed on production — ${title ?? "(untitled)"} (${runId ?? "?"})`,
        project,
        runId,
        title,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return Response.json({ delivered: r.ok });
  } catch {
    return Response.json({ delivered: false }, { status: 502 });
  }
}
