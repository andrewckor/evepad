// Raw byte stream from a project's pty: scrollback replay, then live output.
// The client feeds chunks straight into xterm.write().

import { getTerm } from "../../../../lib/terminals.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const name = new URL(request.url).searchParams.get("project") ?? "";
  const term = getTerm(name);
  if (!term) return new Response("no terminal", { status: 404 });

  let ctrl;
  const stream = new ReadableStream({
    start(controller) {
      ctrl = controller;
      for (const buf of term.scrollback) controller.enqueue(buf);
      if (term.exited) { controller.close(); return; }
      term.subscribers.add(controller);
    },
    cancel() {
      term.subscribers.delete(ctrl);
    },
  });

  request.signal.addEventListener("abort", () => {
    term.subscribers.delete(ctrl);
  });

  return new Response(stream, {
    headers: { "content-type": "application/octet-stream", "cache-control": "no-cache" },
  });
}
