// Pipe a session's NDJSON lifecycle stream from the local eve server to the
// browser. The stream stays open across turns, so one connection serves the
// whole conversation.

export const dynamic = "force-dynamic";

const PORT_RE = /^\d{4,5}$/;
const SID_RE = /^[A-Za-z0-9_-]{10,80}$/;

export async function GET(request) {
  const q = new URL(request.url).searchParams;
  const port = q.get("port") ?? "";
  const sessionId = q.get("sessionId") ?? "";
  if (!PORT_RE.test(port) || !SID_RE.test(sessionId))
    return new Response("bad params", { status: 400 });

  try {
    const r = await fetch(
      `http://127.0.0.1:${port}/eve/v1/session/${encodeURIComponent(sessionId)}/stream`,
      { signal: request.signal },
    );
    return new Response(r.body, {
      status: r.status,
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" },
    });
  } catch {
    return new Response("stream unavailable", { status: 502 });
  }
}
