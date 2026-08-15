// Long-lived NDJSON passthrough of the opencode event bus for one checkout.
// The UI renders exclusively from this stream after hydrating: part deltas,
// part/message updates, session status, and permission asks.

import { resolveProject } from "../../../../lib/projects.js";
import { eventHub } from "../../../../lib/opencode.js";

export const dynamic = "force-dynamic";

const FORWARD = new Set([
  "message.updated",
  "message.part.updated",
  "message.part.delta",
  "session.updated",
  "session.diff",
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

  let hub;
  try {
    hub = await eventHub(project.localPath);
  } catch (e) {
    return new Response(String(e.message ?? e), { status: 502 });
  }

  const enc = new TextEncoder();
  let listener;
  const stream = new ReadableStream({
    start(controller) {
      const push = (ev) => {
        if (!FORWARD.has(ev.type)) return;
        let out = ev;
        if (ev.type === "session.diff") {
          // Strip file contents — the chip only needs names and counts.
          out = { type: ev.type, properties: {
            sessionID: ev.properties?.sessionID,
            diff: (ev.properties?.diff ?? []).map((d) => ({ file: d.file, additions: d.additions, deletions: d.deletions })),
          } };
        }
        try { controller.enqueue(enc.encode(JSON.stringify(out) + "\n")); }
        catch { hub.subs.delete(listener); }
      };
      controller.enqueue(enc.encode(JSON.stringify({ type: "hello", hub: { state: hub.state, events: hub.events, subs: hub.subs.size, pending: hub.pending.size, types: hub.types } }) + "\n"));
      // Replay asks that are still unanswered — a reload must not lose them.
      for (const pe of hub.pending.values()) push(pe);
      listener = push;
      hub.subs.add(listener);
      request.signal.addEventListener("abort", () => {
        hub.subs.delete(listener);
        try { controller.close(); } catch {}
      });
    },
    cancel() { hub.subs.delete(listener); },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" },
  });
}
