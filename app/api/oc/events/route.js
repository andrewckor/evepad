// Long-lived NDJSON passthrough of the opencode event bus for one checkout.
// The UI renders exclusively from this stream after hydrating: part deltas,
// part/message updates, session status, and permission asks.

import { resolveProject } from "../../../../lib/projects.js";
import { ocClient } from "../../../../lib/opencode.js";

export const dynamic = "force-dynamic";

const FORWARD = new Set([
  "message.updated",
  "message.part.updated",
  "message.part.delta",
  "session.updated",
  "session.status",
  "session.idle",
  "session.error",
  "permission.asked",
  "permission.updated",
  "permission.replied",
]);

export async function GET(request) {
  const name = new URL(request.url).searchParams.get("project") ?? "";
  const project = await resolveProject(name);
  if (!project?.localPath) return new Response("no local checkout", { status: 409 });

  let client, dir;
  try {
    ({ client, dir } = await ocClient(project.localPath));
  } catch (e) {
    return new Response(String(e.message ?? e), { status: 502 });
  }

  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort());
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const sub = await client.event.subscribe({ query: { directory: dir }, signal: abort.signal });
        controller.enqueue(enc.encode(JSON.stringify({ type: "hello" }) + "\n"));
        for await (const ev of sub.stream) {
          if (!FORWARD.has(ev.type)) continue;
          controller.enqueue(enc.encode(JSON.stringify(ev) + "\n"));
        }
      } catch {} // client went away or server rebooted — the UI reconnects
      try { controller.close(); } catch {}
    },
    cancel() { abort.abort(); },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" },
  });
}
