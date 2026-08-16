// Signing in, from inside the cockpit.
//
// `vercel login` is a device flow: it prints a URL carrying a user code, then
// blocks until the browser side completes and it writes auth.json. So the
// cockpit runs it, scrapes that URL out of its output, hands it to the UI, and
// lets the page poll /api/account until credentials exist. Nothing here
// invents an auth path of its own — the CLI stays the only thing that holds a
// token, and the file it writes is the one every other route already reads.

import { spawn } from "node:child_process";

export const dynamic = "force-dynamic";

// One login at a time, on globalThis so a page reload rejoins the flow in
// progress instead of starting a second CLI against the same credentials file.
const g = globalThis;
g.__login ??= null;

const URL_RE = /(https:\/\/vercel\.com\/oauth\/device\?user_code=[A-Z0-9-]+)/i;
// The CLI paints its output with ANSI; the URL survives it, the noise doesn't.
const clean = (s) => s.replace(/\[[0-9;]*[A-Za-z]/g, "");

function start() {
  const rec = { url: null, code: null, state: "starting", error: null, at: Date.now() };
  const child = spawn("vercel", ["login"], {
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  rec.child = child;

  const onData = (buf) => {
    const text = clean(String(buf));
    const m = text.match(URL_RE);
    if (m && !rec.url) {
      rec.url = m[1];
      rec.code = new URL(m[1]).searchParams.get("user_code");
      rec.state = "waiting";
    }
    if (/Congratulations|now signed in/i.test(text)) rec.state = "done";
    if (/cancell?ed/i.test(text)) rec.state = "cancelled";
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (e) => { rec.state = "error"; rec.error = String(e.message ?? e); });
  child.on("exit", (code) => {
    if (rec.state === "done") return;
    rec.state = code === 0 ? "done" : rec.state === "waiting" ? "expired" : "error";
  });
  return rec;
}

const view = (r) => (r ? { state: r.state, url: r.url, code: r.code, error: r.error } : null);

export async function GET() {
  return Response.json({ login: view(g.__login) });
}

export async function POST(request) {
  const { action } = await request.json().catch(() => ({}));

  if (action === "cancel") {
    try { g.__login?.child?.kill(); } catch {}
    g.__login = null;
    return Response.json({ ok: true });
  }

  if (action !== "login") return Response.json({ error: "unknown action" }, { status: 400 });

  const live = g.__login;
  if (live && ["starting", "waiting"].includes(live.state) && Date.now() - live.at < 10 * 60_000) {
    return Response.json({ login: view(live) });
  }

  const rec = start();
  g.__login = rec;

  // Wait briefly for the device URL — it arrives in well under a second, and
  // answering without it would only make the client poll for it.
  for (let i = 0; i < 60 && !rec.url && rec.state === "starting"; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return Response.json({ login: view(rec) });
}
