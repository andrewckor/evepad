import { isLocalAgentDiscoveryNeeded } from "@/lib/local-discovery";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ required: isLocalAgentDiscoveryNeeded() });
}
