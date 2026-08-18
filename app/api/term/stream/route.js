// Raw byte stream from a project's pty: scrollback replay, then live output.
// The client feeds chunks straight into xterm.write().

// Lazy for the same reason as the control route: node-pty is optional.
const terminals = () => import("../../../../lib/terminals.js");

export const dynamic = "force-dynamic";

export async function GET(request) {
  let getTerm;
  try { ({ getTerm } = await terminals()); }
  catch { return new Response("terminals unavailable on this platform", { status: 501 }); }

  const url = new URL(request.url);
  const name = url.searchParams.get("project") ?? "";
  const term = getTerm(name, url.searchParams.get("variant") ?? undefined);
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
