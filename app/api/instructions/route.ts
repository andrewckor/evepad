// The agent's instructions.md — the file eve treats as its system prompt.
// Read and write it directly: it is one fixed path inside the checkout, so no
// path handling beyond resolveProject is needed.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveProject } from "@/lib/projects";
import { errMsg } from "@/lib/utils";
import { instructionsTooLarge } from "@/lib/instructions";

const pathOf = (localPath: string) => join(localPath, "agent", "instructions.md");

export async function GET(request: Request) {
  const name = new URL(request.url).searchParams.get("project") ?? "";
  const project = await resolveProject(name);
  if (!project?.localPath) return Response.json({ error: "No local checkout." }, { status: 409 });
  try {
    const p = pathOf(project.localPath);
    if (!existsSync(p)) return Response.json({ text: "", exists: false });
    return Response.json({ text: readFileSync(p, "utf8"), exists: true });
  } catch (e) {
    return Response.json({ error: errMsg(e).slice(0, 200) }, { status: 502 });
  }
}

export async function PUT(request: Request) {
  const { project: name, text } = await request.json();
  if (typeof text !== "string") return Response.json({ error: "no text" }, { status: 400 });
  if (instructionsTooLarge(text))
    return Response.json({ error: "instructions.md over 256KB." }, { status: 413 });

  const project = await resolveProject(name);
  if (!project?.localPath) return Response.json({ error: "No local checkout." }, { status: 409 });
  try {
    writeFileSync(pathOf(project.localPath), text);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: errMsg(e).slice(0, 200) }, { status: 502 });
  }
}
