// Fallback discovery of pending permission asks. The event bus is the primary
// path, but opencode's per-instance buses can starve subscriptions (instance
// disposal, SDK-internal SSE retries), and pending asks are not listable via
// any API. The server log IS authoritative about asks, and the session's
// message state says whether a run is actually waiting — combine the two.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveProject } from "@/lib/projects";
import { ocClient, listQuestions, listPermissions } from "@/lib/opencode";
import { errMsg } from "@/lib/utils";

export const dynamic = "force-dynamic";

const LOG = join(homedir(), ".local", "share", "opencode", "log", "opencode.log");

export async function GET(request: Request) {
  const url = new URL(request.url);
  const name = url.searchParams.get("project") ?? "";
  const sessionId = url.searchParams.get("session") ?? "";
  const project = await resolveProject(name);
  if (!project?.localPath) return Response.json({ error: "No local checkout." }, { status: 409 });
  if (!sessionId) return Response.json({ pending: [] });

  try {
    const { client, dir } = await ocClient(project.localPath);
    const res = await client.session.messages({
      path: { id: sessionId },
      query: { directory: dir },
      throwOnError: true,
    });
    const last = res.data.at(-1);
    const waitingParts =
      last?.info.role === "assistant"
        ? last.parts.filter(
            (p) => p.type === "tool" && ["pending", "running"].includes(p.state?.status),
          )
        : [];
    if (!waitingParts.length) return Response.json({ pending: [], questions: [] });

    // Questions ARE listable (unlike permissions) — ask the server directly.
    let questions: Awaited<ReturnType<typeof listQuestions>> = [];
    try {
      questions = (await listQuestions(dir)).filter((q) => q.sessionID === sessionId);
    } catch {}
    // Server truth first — asks lost in event-bus gaps are still listed
    // here. The log parse below is only the fallback.
    try {
      const live = (await listPermissions(dir)).filter((p) => p.sessionID === sessionId);
      return Response.json({ pending: live, questions });
    } catch {}

    // Question-waiting parts must not inflate the permission cap below, or
    // stale asks resurface from the log tail.
    const askedCalls = new Set(questions.map((q) => q.tool?.callID).filter(Boolean));
    const waitingPerms = waitingParts.filter(
      (p) => !(p.type === "tool" && (p.tool === "question" || askedCalls.has(p.callID))),
    );
    if (!waitingPerms.length) return Response.json({ pending: [], questions });

    // The run is waiting on something. Find its run-context ids in the log
    // (lines mentioning this session), then that context's trailing asks.
    let tail = "";
    try {
      const buf = readFileSync(LOG, "utf8");
      tail = buf.slice(-400_000);
    } catch {
      return Response.json({ pending: [], questions });
    }

    const runIds = new Set();
    for (const m of tail.matchAll(/run=([0-9a-f]+)[^\n]*session\.id=/g)) {
      if (tail.includes(`run=${m[1]}`) && tail.slice(m.index, m.index + 400).includes(sessionId))
        runIds.add(m[1]);
    }
    const asks: Array<{ id?: string; permission?: string; patterns: string[]; ts?: string }> = [];
    for (const m of tail.matchAll(
      /timestamp=(\S+) level=INFO run=([0-9a-f]+) message=asking id=(per_\w+) permission=(\w+) patterns="((?:[^"\\]|\\.)*)"/g,
    )) {
      const [, ts, run, id, permission, rawPatterns] = m;
      if (!runIds.has(run)) continue;
      let patterns: string[] = [];
      try {
        patterns = JSON.parse((rawPatterns ?? "").replace(/\\"/g, '"'));
      } catch {}
      asks.push({ id, permission, patterns, ts });
    }
    // Only the newest asks can still be pending — cap to the number of
    // tool parts actually waiting.
    const pending = asks.slice(-Math.max(waitingPerms.length, 1)).map((a) => ({
      id: a.id,
      sessionID: sessionId,
      permission: a.permission,
      patterns: a.patterns,
      metadata: { command: a.patterns.join(" && ") },
      fromLog: true,
    }));
    return Response.json({ pending, questions });
  } catch (e) {
    return Response.json({ error: errMsg(e).slice(0, 200) }, { status: 502 });
  }
}
