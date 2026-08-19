// Change notifier for an open run: tails the run's user stream from its
// current end via `streams.get()` (a live ReadableStream that waits for new
// chunks) and emits one NDJSON line per arrival. No decoding here — the
// client responds to a nudge by refetching the snapshot with fresh=1, so the
// battle-tested decode pipeline stays the single source of truth.

import { worldFor } from "@/lib/vercel-client";
import { resolveProject } from "@/lib/projects";
import { errMsg } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const q = new URL(request.url).searchParams;
  const environment = q.get("environment") ?? "production";
  const name = q.get("project") ?? "";
  if (environment === "local") return new Response("local runs poll files", { status: 400 });
  const project = await resolveProject(name);
  if (!project) return new Response("unknown project", { status: 404 });

  let world: Awaited<ReturnType<typeof worldFor>>;
  try {
    world = await worldFor(project, environment);
  } catch (e) {
    return new Response(errMsg(e), { status: 502 });
  }
  const streamId = `strm_${runId.replace(/^wrun_/, "")}_user`;

  const enc = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const frame = (o: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
        } catch {
          closed = true;
        }
      };
      request.signal.addEventListener("abort", () => {
        closed = true;
        try {
          controller.close();
        } catch {}
      });
      try {
        // Start tailing AFTER the chunks the snapshot already covers.
        let start = 0;
        try {
          const info = await world.streams.getInfo(runId, streamId);
          start = (info?.tailIndex ?? -1) + 1;
          if (info?.done) {
            frame({ type: "done" });
            try {
              controller.close();
            } catch {}
            return;
          }
        } catch {} // no chunks yet — tail from 0
        frame({ type: "tailing", from: start });
        const rs = await world.streams.get(runId, streamId, start);
        const reader = rs.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done || closed) break;
          // Payload contents don't matter — this is only a nudge.
          frame({ type: "chunk", bytes: value?.length ?? 0 });
        }
        frame({ type: "done" });
      } catch (e) {
        frame({ type: "error", error: errMsg(e).slice(0, 200) });
      }
      closed = true;
      try {
        controller.close();
      } catch {}
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" },
  });
}
