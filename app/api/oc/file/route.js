// One file's changes, as hunks.
//
// NOT from OpenCode: its /file/content declares `diff` and `patch` in the SDK
// types but this server version returns only {type, content}, and both
// /file/status and /session/{id}/diff come back empty even for files a session
// just edited. Verified against a live server before falling back.
//
// git is the source of truth instead, which is honest anyway: the diff a
// person wants to see is "what changed in my checkout", and evepad runs on the
// machine that holds it. Projects that aren't git repos simply have no diff to
// show, which the UI states plainly.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { relative, isAbsolute } from "node:path";
import { resolveProject } from "../../../../lib/projects.js";

const exec = promisify(execFile);
export const dynamic = "force-dynamic";

// A unified diff is line-oriented text; hunks are what a renderer needs.
function parseHunks(patch) {
  const hunks = [];
  let current = null;
  for (const line of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      current = {
        oldStart: +header[1], oldLines: header[2] ? +header[2] : 1,
        newStart: +header[3], newLines: header[4] ? +header[4] : 1,
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    // Everything before the first @@ is git's file header — not content.
    if (!current) continue;
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) current.lines.push(line);
  }
  return hunks;
}

export async function GET(request) {
  const url = new URL(request.url);
  const name = url.searchParams.get("project") ?? "";
  const raw = url.searchParams.get("path") ?? "";
  if (!raw) return Response.json({ error: "no path" }, { status: 400 });

  const project = await resolveProject(name);
  if (!project?.localPath) return Response.json({ error: "No local checkout." }, { status: 409 });

  // Patch parts name files absolutely; the chip names them relative. Both end
  // up relative to the checkout, which is what git wants.
  const file = isAbsolute(raw) ? relative(project.localPath, raw) : raw;
  if (file.startsWith("..")) return Response.json({ error: "Outside this agent's folder." }, { status: 400 });

  try {
    // HEAD-relative so a staged-but-uncommitted edit still shows; --no-color
    // because the renderer draws its own.
    const { stdout } = await exec(
      "git", ["diff", "HEAD", "--no-color", "-U3", "--", file],
      { cwd: project.localPath, timeout: 15_000, maxBuffer: 8 << 20 },
    );
    return Response.json({ file, hunks: parseHunks(stdout) });
  } catch (e) {
    // Not a repo, or no commits yet — a real state, not a failure.
    if (/not a git repository|unknown revision|ambiguous argument|could not access/i.test(String(e.stderr ?? e.message)))
      return Response.json({ file, hunks: [], note: "No git history for this agent." });
    return Response.json({ error: String(e.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
