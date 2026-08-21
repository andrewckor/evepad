// The checkout's evals, as eve's own runner discovers them. Listing shells out
// to `eve eval --list --json` (discovery imports the authored files — not
// something to reimplement), so the answer is cached briefly: this is an
// on-demand view, never a polling path.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveProject } from "@/lib/projects";
import { errMsg } from "@/lib/utils";
import { evalsNoteFromFailure } from "@/lib/evals-note";

const exec = promisify(execFile);

export type EvalInfo = { id: string; description?: string; tags?: string[] };

const CACHE_TTL = 60_000;
const cache = new Map<string, { at: number; data: { evals: EvalInfo[]; note: string | null } }>();

export async function GET(request: Request) {
  const name = new URL(request.url).searchParams.get("project") ?? "";
  const project = await resolveProject(name);
  if (!project?.localPath) return Response.json({ error: "No local checkout." }, { status: 409 });

  const hit = cache.get(project.localPath);
  if (hit && Date.now() - hit.at < CACHE_TTL) return Response.json(hit.data);

  try {
    const { stdout } = await exec("npm", ["exec", "--", "eve", "eval", "--list", "--json"], {
      cwd: project.localPath,
      timeout: 90_000,
      maxBuffer: 4 << 20,
    });
    const data = { evals: JSON.parse(stdout) as EvalInfo[], note: null };
    cache.set(project.localPath, { at: Date.now(), data });
    return Response.json(data);
  } catch (e) {
    // Eve's own "No evals found" exit is a state the pane explains, not an error.
    const err = e as { stderr?: string; message?: string };
    const note = evalsNoteFromFailure(err.stderr, errMsg(e));
    const data = { evals: [], note: note.message };
    if (note.kind === "empty") cache.set(project.localPath, { at: Date.now(), data });
    return Response.json(data);
  }
}
