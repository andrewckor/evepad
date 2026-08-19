// Every changed file in the checkout, with its +/- counts.
//
// One git call for the whole project rather than one per card: a transcript
// can hold dozens of patch cards, and spawning a process per file on mount is
// exactly the kind of thing this app refuses to do. The hunks themselves stay
// lazy (see oc/file) — this is only what the collapsed rows need.
//
// Replaces OpenCode's session.diff, which returns [] on this server version
// even for sessions that just edited files.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveProject } from "@/lib/projects";

const exec = promisify(execFile);
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const name = new URL(request.url).searchParams.get("project") ?? "";
  const project = await resolveProject(name);
  if (!project?.localPath) return Response.json({ error: "No local checkout." }, { status: 409 });

  try {
    const { stdout } = await exec("git", ["diff", "HEAD", "--numstat"], {
      cwd: project.localPath,
      timeout: 10_000,
      maxBuffer: 4 << 20,
    });
    const files = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        // "additions<TAB>deletions<TAB>path"; binary files report "-".
        const [a, d, ...rest] = line.split("\t");
        return { file: rest.join("\t"), additions: Number(a) || 0, deletions: Number(d) || 0 };
      });
    return Response.json({ files });
  } catch {
    // No repo or no commits yet — nothing to compare against, not an error.
    return Response.json({ files: [] });
  }
}
