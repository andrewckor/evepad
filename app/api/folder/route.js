// The machine's folder picker. Not agent-specific on purpose: creating an
// agent and setting the default workspace both need "ask the user for a
// directory", and that is a capability of the host, not of either feature.
//
// The server runs on the user's own machine, so this can be the real native
// picker — a browser file input can't return an absolute path.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureWorkspace } from "../../../lib/settings.js";

const exec = promisify(execFile);

export async function POST(request) {
  const { prompt, start } = await request.json().catch(() => ({}));
  // Open where the user's agents live, when that folder exists. osascript
  // rejects a default location that doesn't (-1700), so the hint is omitted
  // rather than guessed.
  const from = start ?? ensureWorkspace();
  const where = from ? ` default location POSIX file ${JSON.stringify(from)}` : "";
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
