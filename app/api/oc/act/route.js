// Actions from the custom UI, mapped 1:1 onto opencode server endpoints.
// Prompt/command runs are fire-and-forget — progress and results arrive on
// the event stream, errors as session.error events.

import { resolveProject } from "../../../../lib/projects.js";
import { ocClient, eventHub, DEFAULTS } from "../../../../lib/opencode.js";

export async function POST(request) {
  const { project: name, action, sessionId, text, command, args, provider, model, agent, permissionId, response } =
    await request.json();
  const project = await resolveProject(name);
  if (!project?.localPath) return Response.json({ error: "No local checkout." }, { status: 409 });

  let client, dir;
  try {
    ({ client, dir } = await ocClient(project.localPath));
  } catch (e) {
    return Response.json({ error: String(e.message ?? e).slice(0, 250) }, { status: 502 });
  }
  const path = { id: sessionId };
  const query = { directory: dir };
  const swallow = (p) => p.catch((e) => console.warn("[oc/act] run failed:", String(e.message ?? e).slice(0, 200)));

  try {
    switch (action) {
      case "new": {
        const created = await client.session.create({
          query, body: { title: `cockpit: ${project.name}` }, throwOnError: true,
        });
        return Response.json({ id: created.data.id, title: created.data.title });
      }
      case "prompt":
        // Re-attach the event hub to the instance this run wakes — otherwise
        // a post-idle run streams into a bus nobody is subscribed to.
        await (await eventHub(dir)).resubscribe();
        swallow(client.session.prompt({
          path, query,
          body: {
            model: { providerID: provider || DEFAULTS.provider, modelID: model || DEFAULTS.model },
            agent: agent || undefined,
            parts: [{ type: "text", text }],
          },
          throwOnError: true,
        }));
        return Response.json({ ok: true });
      case "command":
        await (await eventHub(dir)).resubscribe();
        swallow(client.session.command({
          path, query,
          body: { command, arguments: args ?? "", model: model ? `${provider || DEFAULTS.provider}/${model}` : undefined },
          throwOnError: true,
        }));
        return Response.json({ ok: true });
      case "undo": {
        // Revert to before the last assistant message's changes.
        const msgs = await client.session.messages({ path, query, throwOnError: true });
        const lastAssistant = [...msgs.data].reverse().find((m) => m.info.role === "assistant");
        if (!lastAssistant) return Response.json({ error: "nothing to undo" }, { status: 400 });
        await client.session.revert({ path, query, body: { messageID: lastAssistant.info.id }, throwOnError: true });
        return Response.json({ ok: true, note: "reverted" });
      }
      case "redo":
        await client.session.unrevert({ path, query, throwOnError: true });
        return Response.json({ ok: true, note: "restored" });
      case "compact":
        swallow(client.session.summarize({
          path, query,
          body: { providerID: provider || DEFAULTS.provider, modelID: model || DEFAULTS.model },
          throwOnError: true,
        }));
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
        return Response.json({ diff: (r.data ?? []).map((d) => ({ file: d.file, additions: d.additions, deletions: d.deletions })) });
      }
      case "abort":
        await client.session.abort({ path, query, throwOnError: true });
        return Response.json({ ok: true });
      case "permission":
        await client.postSessionIdPermissionsPermissionId({
          path: { id: sessionId, permissionID: permissionId },
          query, body: { response }, throwOnError: true,
        });
        return Response.json({ ok: true });
      default:
        return Response.json({ error: `unknown action ${action}` }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: String(e.message ?? e).slice(0, 250) }, { status: 502 });
  }
}
