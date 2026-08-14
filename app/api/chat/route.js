// Forward a chat message to a locally running eve dev server.
// Create: POST /eve/v1/session  ·  Follow-up: POST /eve/v1/session/:id
// Proxied because the eve server doesn't send CORS headers for the cockpit origin.

const PORT_RE = /^\d{4,5}$/;
const SID_RE = /^[A-Za-z0-9_-]{10,80}$/;

export async function POST(request) {
  const { port, sessionId, message, continuationToken } = await request.json();
  if (!PORT_RE.test(String(port))) return Response.json({ error: "bad port" }, { status: 400 });
  if (sessionId && !SID_RE.test(sessionId)) return Response.json({ error: "bad session id" }, { status: 400 });
  if (typeof message !== "string" || !message.trim())
    return Response.json({ error: "empty message" }, { status: 400 });

  const base = `http://127.0.0.1:${port}/eve/v1/session`;
  const url = sessionId ? `${base}/${encodeURIComponent(sessionId)}` : base;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Follow-ups require the continuationToken from the previous response.
      body: JSON.stringify(continuationToken ? { message, continuationToken } : { message }),
    });
    return Response.json(await r.json(), { status: r.status });
  } catch {
    return Response.json({ error: `No eve server answering on :${port}` }, { status: 502 });
  }
}
