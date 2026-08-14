import { listProjects } from "../../../lib/projects.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({ projects: await listProjects() });
  } catch (e) {
    return Response.json({ projects: [], error: String(e.message ?? e) }, { status: 500 });
  }
}
