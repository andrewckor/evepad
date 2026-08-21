import {
  getWorkspace,
  setWorkspace,
  workspaceError,
  getAlertWebhook,
  setAlertWebhook,
  DEFAULT_WORKSPACE,
} from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    workspace: getWorkspace(),
    default: DEFAULT_WORKSPACE,
    alertWebhook: getAlertWebhook(),
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}) as Record<string, unknown>);

  if (typeof body.alertWebhook === "string" || "alertWebhook" in body) {
    const bad = setAlertWebhook(body.alertWebhook as string);
    if (bad) return Response.json({ error: bad }, { status: 422 });
    if (!("workspace" in body)) return Response.json({ ok: true, alertWebhook: getAlertWebhook() });
  }

  const bad = workspaceError(body.workspace);
  if (bad) return Response.json({ error: bad }, { status: 422 });
  setWorkspace(body.workspace as string);
  return Response.json({ ok: true, workspace: getWorkspace() });
}
