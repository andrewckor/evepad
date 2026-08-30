// Long-lived NDJSON passthrough of the opencode event bus for one checkout.
// The UI renders exclusively from this stream after hydrating: part deltas,
// part/message updates, session status, and permission asks.

import { resolveProject } from "@/lib/projects";
import { eventHub, type OcEvent } from "@/lib/opencode";
import { errMsg } from "@/lib/utils";

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
  "question.asked",
  "question.replied",
  "question.rejected",
]);

export async function GET(request: Request) {
  const name = new URL(request.url).searchParams.get("project") ?? "";
  const project = await resolveProject(name);
  if (!project?.localPath) return new Response("no local checkout", { status: 409 });

  let hub: Awaited<ReturnType<typeof eventHub>>;
  try {
    hub = await eventHub(project.localPath);
  } catch (e) {
    return new Response(errMsg(e), { status: 502 });
  }

  const enc = new TextEncoder();
  let listener: ((ev: OcEvent) => void) | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const push = (ev: OcEvent) => {
        if (!FORWARD.has(ev.type)) return;
        let out: unknown = ev;
        if (ev.type === "session.diff") {
          // Strip file contents — the chip only needs names and counts.
          out = {
            type: ev.type,
            properties: {
              sessionID: ev.properties?.sessionID,
              diff: (
                (ev.properties?.diff ?? []) as Array<{
                  file: string;
                  additions: number;
                  deletions: number;
                }>
              ).map((d) => ({ file: d.file, additions: d.additions, deletions: d.deletions })),
            },
          };
        }
        try {
          controller.enqueue(enc.encode(JSON.stringify(out) + "\n"));
        } catch {
          if (listener) hub.subs.delete(listener);
        }
      };
      controller.enqueue(
        enc.encode(
          JSON.stringify({
            type: "hello",
            hub: {
              state: hub.state,
              events: hub.events,
              subs: hub.subs.size,
              pending: hub.pending.size,
              types: hub.types,
            },
          }) + "\n",
        ),
      );
      // Replay asks that are still unanswered — a reload must not lose them.
      for (const pe of hub.pending.values()) push(pe);
      listener = push;
      hub.subs.add(listener);
      request.signal.addEventListener("abort", () => {
        if (listener) hub.subs.delete(listener);
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      if (listener) hub.subs.delete(listener);
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" },
  });
}
