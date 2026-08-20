// Signing out. Signing IN is the CLI's job — `vercel login` owns the device
// flow and writes the credentials every other route reads, so evepad
// watches for them (see /api/account) rather than running a second auth path
// of its own that could drift from the CLI's.

import { spawn } from "node:child_process";
import { vercelCommand } from "@/lib/vercel-cli";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { action } = await request.json().catch(() => ({}));
  if (action !== "logout") return Response.json({ error: "unknown action" }, { status: 400 });

  // `vercel logout` clears the CLI's credentials for the whole machine, not
  // just this app — evepad has no session of its own to end.
  const code = await new Promise<number>((resolve) => {
    const [vc, ...pre] = vercelCommand() as [string, ...string[]];
    const child = spawn(vc, [...pre, "logout"], { stdio: "ignore" });
    child.on("error", () => resolve(-1));
    child.on("exit", (c) => resolve(c ?? -1));
  });

  return code === 0
    ? Response.json({ ok: true })
    : Response.json({ error: "vercel logout failed" }, { status: 502 });
}
