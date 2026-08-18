// The machine's folder picker. Not agent-specific on purpose: creating an
// agent and setting the default workspace both need "ask the user for a
// directory", and that is a capability of the host, not of either feature.
//
// The server runs on the user's own machine, so this can be the real native
// picker — a browser file input can't return an absolute path.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { getWorkspace } from "../../../lib/settings.js";

const exec = promisify(execFile);

export async function POST(request) {
  const { prompt, start } = await request.json().catch(() => ({}));
  // Opening a picker must not touch the disk. This used to call
  // ensureWorkspace(), which CREATED ~/eve-agents just to compute a starting
  // point — a read with a side effect, and it quietly resurrected the folder
  // after every cleanup. The hint is used only if the folder already exists;
  // osascript rejects one that doesn't (-1700), so it's omitted otherwise.
  const from = start ?? getWorkspace();
  const where = from && existsSync(from) ? ` default location POSIX file ${JSON.stringify(from)}` : "";
  const title = typeof prompt === "string" && prompt ? prompt : "Choose a folder";

  try {
    const { stdout } = await exec(
      "osascript",
      ["-e", `POSIX path of (choose folder with prompt ${JSON.stringify(title)}${where})`],
      { timeout: 120_000 },
    );
    return Response.json({ ok: true, path: stdout.trim().replace(/\/$/, "") });
  } catch (e) {
    // Exit 1 with "User canceled" is the normal cancel path, not an error.
    if (String(e.stderr ?? e.message).includes("canceled")) return Response.json({ ok: false, cancelled: true });
    return Response.json({ error: "Could not open the folder picker." }, { status: 500 });
  }
}
