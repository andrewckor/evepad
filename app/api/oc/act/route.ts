// Actions from the custom UI, mapped 1:1 onto opencode server endpoints.
// Prompt/command runs are fire-and-forget — progress and results arrive on
// the event stream, errors as session.error events.

import { resolveProject } from "@/lib/projects";
import { ocClient, eventHub, answerQuestion, listPermissions, DEFAULTS } from "@/lib/opencode";
import { addPermissionAllows } from "@/lib/settings";
import { errMsg } from "@/lib/utils";

export async function POST(request: Request) {
  const {
    project: name,
    action,
    sessionId,
    text,
    command,
    args,
    provider,
    model,
    agent,
    permissionId,
    response,
    requestId,
    answers,
  } = await request.json();
  const project = await resolveProject(name);
  if (!project?.localPath) return Response.json({ error: "No local checkout." }, { status: 409 });

  let client, dir;
  try {
    ({ client, dir } = await ocClient(project.localPath));
  } catch (e) {
    return Response.json({ error: errMsg(e).slice(0, 250) }, { status: 502 });
  }
  const path = { id: sessionId };
  const query = { directory: dir };
  const swallow = (p: Promise<unknown>) =>
    p.catch((e: unknown) => console.warn("[oc/act] run failed:", errMsg(e).slice(0, 200)));

  try {
    switch (action) {
      case "new": {
        const created = await client.session.create({
          query,
          body: { title: `evepad: ${project.name}` },
          throwOnError: true,
        });
        return Response.json({ id: created.data.id, title: created.data.title });
      }
      case "prompt":
        // Re-attach the event hub to the instance this run wakes — otherwise
        // a post-idle run streams into a bus nobody is subscribed to.
        await (await eventHub(dir)).resubscribe?.();
        swallow(
          client.session.prompt({
            path,
            query,
            body: {
              model: {
                providerID: provider || DEFAULTS.provider,
                modelID: model || DEFAULTS.model,
              },
              agent: agent || undefined,
              parts: [{ type: "text", text }],
            },
            throwOnError: true,
          }),
        );
        return Response.json({ ok: true });
      case "command":
        await (await eventHub(dir)).resubscribe?.();
        swallow(
          client.session.command({
            path,
            query,
            body: {
              command,
              arguments: args ?? "",
              model: model ? `${provider || DEFAULTS.provider}/${model}` : undefined,
            },
            throwOnError: true,
          }),
        );
        return Response.json({ ok: true });
      case "undo": {
        // Revert to before the last assistant message's changes.
        const msgs = await client.session.messages({ path, query, throwOnError: true });
        const lastAssistant = [...msgs.data].reverse().find((m) => m.info.role === "assistant");
        if (!lastAssistant) return Response.json({ error: "nothing to undo" }, { status: 400 });
        await client.session.revert({
          path,
          query,
          body: { messageID: lastAssistant.info.id },
          throwOnError: true,
        });
        return Response.json({ ok: true, note: "reverted" });
      }
      case "redo":
        await client.session.unrevert({ path, query, throwOnError: true });
        return Response.json({ ok: true, note: "restored" });
      case "compact":
        swallow(
          client.session.summarize({
            path,
            query,
            body: { providerID: provider || DEFAULTS.provider, modelID: model || DEFAULTS.model },
            throwOnError: true,
          }),
        );
        return Response.json({ ok: true });
      case "share": {
        const r = await client.session.share({ path, query, throwOnError: true });
        return Response.json({ ok: true, url: r.data.share?.url ?? null });
      }
      case "unshare":
        await client.session.unshare({ path, query, throwOnError: true });
        return Response.json({ ok: true });
      case "diff": {
        const r = await client.session.diff({ path, query, throwOnError: true });
        return Response.json({
          diff: (r.data ?? []).map((d) => ({
            file: d.file,
            additions: d.additions,
            deletions: d.deletions,
          })),
        });
      }
      case "abort":
        await client.session.abort({ path, query, throwOnError: true });
        return Response.json({ ok: true });
      case "permission": {
        // Patterns for a machine-wide "always" come from the server's own
        // record of the ask, never from the client — and are read BEFORE the
        // reply consumes it.
        let askPatterns: string[] = [];
        if (response === "always") {
          try {
            const ask = (await listPermissions(dir)).find((p) => p.id === permissionId);
            const raw = ask?.patterns;
            if (Array.isArray(raw)) askPatterns = raw.filter((p) => typeof p === "string");
          } catch {}
        }
        await client.postSessionIdPermissionsPermissionId({
          path: { id: sessionId, permissionID: permissionId },
          query,
          body: { response },
          throwOnError: true,
        });
        // "Always" should outlive this agent, not just this project: opencode
        // records it per project; evepad also records the patterns machine-
        // wide and feeds them into every server boot (lib/opencode.ts).
        if (askPatterns.length) addPermissionAllows(askPatterns);
        return Response.json({ ok: true });
      }
      case "question":
        // response "reject" declines; anything else replies with the answers
        // (string[][] — one array of selected labels per question, in order).
        await answerQuestion(dir, requestId, response === "reject" ? null : { answers });
        return Response.json({ ok: true });
      default:
        return Response.json({ error: `unknown action ${action}` }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: errMsg(e).slice(0, 250) }, { status: 502 });
  }
}
