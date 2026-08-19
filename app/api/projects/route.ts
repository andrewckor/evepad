import { listProjects } from "@/lib/projects";
import { errMsg } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({ projects: await listProjects() });
  } catch (e) {
    return Response.json({ projects: [], error: errMsg(e) }, { status: 500 });
  }
}
