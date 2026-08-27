import { listProjects } from "@/lib/projects";
import { getAccount } from "@/lib/account";
import {
  isLocalAgentDiscoveryRunning,
  localAgentDiscoveryFoundCount,
  startLocalAgentDiscovery,
} from "@/lib/local-discovery";
import { errMsg } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // First-run discovery belongs to the authenticated dashboard flow. Keep
    // it completely dormant while signed out, even if a stale tab or another
    // caller reaches this endpoint directly.
    const account = await getAccount();
    if (account.loggedIn) startLocalAgentDiscovery();
    const projects = await listProjects();
    return Response.json({
      projects,
      // Report the state at response time. Capturing it before the slower
      // remote fetch let an older response revive an already-finished scan.
      discovering: isLocalAgentDiscoveryRunning(),
      discoveredAgents: localAgentDiscoveryFoundCount(),
    });
  } catch (e) {
    return Response.json({ projects: [], error: errMsg(e) }, { status: 500 });
  }
}
