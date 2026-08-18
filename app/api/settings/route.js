import { getWorkspace, setWorkspace, ensureWorkspace, workspaceError, DEFAULT_WORKSPACE } from "../../../lib/settings.js";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ workspace: getWorkspace(), default: DEFAULT_WORKSPACE });
}

export async function POST(request) {
  const { workspace } = await request.json();
  // Validated first: a folder we can't write to must never become the stored
  // setting, or every later create inherits the failure.
  const bad = workspaceError(workspace);
  if (bad) return Response.json({ error: bad }, { status: 422 });
  setWorkspace(workspace);
  return Response.json({ ok: true, workspace: getWorkspace() });
}
