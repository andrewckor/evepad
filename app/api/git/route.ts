// Git state for a project's checkout, and the commit-and-push that closes the
// loop Build opens when its agent edits files. Arguments are fixed arrays —
// the message rides as one argv entry, never through a shell.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveProject } from "@/lib/projects";
import { errMsg } from "@/lib/utils";
import { parseGitStatus } from "@/lib/git-status";

const exec = promisify(execFile);

// Pushes must fail fast rather than hang on a credential prompt nobody can
// answer inside an HTTP request.
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
const run = (cwd: string, args: string[], timeout = 30_000) =>
  exec("git", args, { cwd, timeout, env: ENV, maxBuffer: 4 << 20 });

export async function GET(request: Request) {
  const name = new URL(request.url).searchParams.get("project") ?? "";
  const project = await resolveProject(name);
  if (!project?.localPath) return Response.json({ error: "No local checkout." }, { status: 409 });

  let stdout: string;
  try {
    ({ stdout } = await run(project.localPath, ["status", "--porcelain=v1", "-b"]));
  } catch (e) {
    if (/not a git repository/i.test(String((e as { stderr?: string }).stderr)))
      return Response.json({ repo: false });
    return Response.json({ error: errMsg(e).slice(0, 200) }, { status: 502 });
  }
  // "## branch...upstream [ahead N]" — everything after is one changed file per line.
  return Response.json(parseGitStatus(stdout));
}

export async function POST(request: Request) {
  const { project: name, message } = await request.json();
  const text = typeof message === "string" ? message.trim().slice(0, 200) : "";
  if (!text) return Response.json({ error: "A commit message is required." }, { status: 400 });

  const project = await resolveProject(name);
  if (!project?.localPath) return Response.json({ error: "No local checkout." }, { status: 409 });
  const dir = project.localPath;

  try {
    await run(dir, ["add", "-A"]);
    const out = await run(dir, ["commit", "-m", text]).catch((e) => {
      if (/nothing to commit/.test(String(e.stdout ?? e.stderr ?? e.message)))
        return { stdout: "", stderr: "" };
      throw e;
    });
    const committed = Boolean(out.stdout || out.stderr);
    try {
      await run(dir, ["push"], 120_000);
      return Response.json({ ok: true, committed, pushed: true });
    } catch (e) {
      const why = String((e as { stderr?: string }).stderr ?? errMsg(e)).trim();
      if (/no upstream|has no upstream/i.test(why))
        return Response.json({
          ok: true,
          committed,
          pushed: false,
          note: "Committed locally — no upstream branch. Push once from your terminal to set it.",
        });
      return Response.json(
        { ok: true, committed, pushed: false, note: why.slice(-300) },
        { status: 502 },
      );
    }
  } catch (e) {
    return Response.json(
      { error: String((e as { stderr?: string }).stderr ?? errMsg(e)).slice(-300) },
      { status: 502 },
    );
  }
}
