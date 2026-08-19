// Thin wrapper over lib/account — the logic lives there so instrumentation.ts
// can warm the same cache at server boot.

import { getAccount } from "@/lib/account";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await getAccount());
}
