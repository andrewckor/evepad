// The generator: turn a prompt into eve agent code via AI Gateway, using the
// TARGET PROJECT'S own OIDC credentials (its .env.local) — no cockpit keys.
// Default model zai/glm-5.2 (free on the gateway through Aug 27).
//
// action:"generate" → {path, code, summary, testPrompt} + current file content
// action:"apply"    → writes the file (agent surface only), returns eve diagnostics

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateText } from "ai";
import { createGateway } from "@ai-sdk/gateway";
import { resolveProject } from "../../../lib/projects.js";

const exec = promisify(execFile);
const DEFAULT_MODEL = "zai/glm-5.2";
// Generation may only touch the agent surface — never arbitrary project files.
const PATH_RE = /^agent\/(tools\/[a-z0-9-]+\.(ts|js)|instructions\.md|agent\.ts)$/;

function readOidc(dir) {
  try {
    const env = readFileSync(join(dir, ".env.local"), "utf8");
    return env.match(/^VERCEL_OIDC_TOKEN="?([^"\n]+)"?/m)?.[1] ?? null;
  } catch { return null; }
}
const isExpired = (t) => {
  try { return JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()).exp * 1000 < Date.now() + 60_000; }
  catch { return true; }
};
// OIDC tokens live ~12h; refresh transparently instead of failing the generation.
async function oidcToken(dir) {
  let t = readOidc(dir);
  if (!t || isExpired(t)) {
    try {
      await exec("vercel", ["env", "pull", ".env.local", "--yes"], { cwd: dir, timeout: 60_000 });
      t = readOidc(dir);
    } catch {}
  }
  return t && !isExpired(t) ? t : null;
}

function agentContext(dir) {
  const read = (p) => { try { return readFileSync(join(dir, p), "utf8"); } catch { return null; } };
  const tools = (() => {
    try { return readdirSync(join(dir, "agent", "tools")).filter((f) => /\.(ts|js)$/.test(f)); } catch { return []; }
  })();
  // One existing tool as a style example beats any amount of prose.
  const example = tools.length ? read(`agent/tools/${tools[0]}`) : null;
  return {
    agentTs: read("agent/agent.ts"),
    instructions: read("agent/instructions.md"),
    tools,
    example,
  };
}

const SYSTEM = (ctx) => `You generate code for an eve agent (Vercel's durable agent framework).

Rules:
- Tools live at agent/tools/<kebab-name>.ts — the filename IS the tool name.
- A tool file: import { defineTool } from "eve/tools"; import { z } from "zod";
  export default defineTool({ description, inputSchema: z.object({...}), execute: async (input) => result });
- execute returns a JSON-serializable value. Use fetch for HTTP. No extra deps unless unavoidable.
- Keep files small and single-purpose. TypeScript.
- instructions.md is the agent's always-on system prompt (markdown).
- agent.ts holds defineAgent({ model }).

Existing agent:
- agent.ts:\n${ctx.agentTs ?? "(missing)"}
- instructions.md:\n${ctx.instructions ?? "(missing)"}
- tools: ${ctx.tools.join(", ") || "(none)"}
${ctx.example ? `- example tool file for style:\n${ctx.example}` : ""}

Respond with ONLY a JSON object, no fences:
{"path": "agent/tools/<name>.ts", "code": "<full file content>", "summary": "<one sentence>", "testPrompt": "<a chat message that would exercise this change>"}
For instruction changes use path agent/instructions.md with the FULL new file content.`;

export async function POST(request) {
  const { project: name, action, prompt, path, code, model } = await request.json();
  const project = await resolveProject(name);
  if (!project?.localPath) return Response.json({ error: "No local checkout for this project." }, { status: 409 });
  const dir = project.localPath;

  if (action === "generate") {
    if (!prompt?.trim()) return Response.json({ error: "Empty prompt." }, { status: 400 });
    const token = await oidcToken(dir);
    if (!token) return Response.json({ error: "No AI Gateway credentials (.env.local) — press play once or run `vercel env pull`." }, { status: 409 });

    // The gateway provider consumes OIDC via env (@vercel/oidc), NOT the apiKey
    // option — apiKey is for AI Gateway API keys and gets rejected for OIDC.
    process.env.VERCEL_OIDC_TOKEN = token;
    const gateway = createGateway();
    try {
      const { text } = await generateText({
        model: gateway(model || DEFAULT_MODEL),
        system: SYSTEM(agentContext(dir)),
        prompt: prompt.trim(),
      });
      const jsonText = text.trim().replace(/^```(json)?\n?/, "").replace(/\n?```$/, "");
      let out;
      try { out = JSON.parse(jsonText); } catch {
        return Response.json({ error: "Model returned malformed output — try rephrasing.", raw: text.slice(0, 800) }, { status: 502 });
      }
      if (!PATH_RE.test(out.path ?? "")) {
        return Response.json({ error: `Refusing path outside the agent surface: ${out.path}` }, { status: 422 });
      }
      const current = existsSync(join(dir, out.path)) ? readFileSync(join(dir, out.path), "utf8") : null;
      return Response.json({ ok: true, ...out, current, model: model || DEFAULT_MODEL });
    } catch (e) {
      return Response.json({ error: `Generation failed: ${String(e.message ?? e).slice(0, 300)}` }, { status: 502 });
    }
  }

  if (action === "apply") {
    if (!PATH_RE.test(path ?? "")) return Response.json({ error: "Path outside the agent surface." }, { status: 422 });
    if (typeof code !== "string" || !code.trim()) return Response.json({ error: "Empty code." }, { status: 400 });
    const target = join(dir, path);
    const previous = existsSync(target) ? readFileSync(target, "utf8") : null;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, code);

    // Validate with eve's own compiler diagnostics; the dev server hot-reloads
    // the change on its own.
    let diagnostics = null;
    try {
      const { stdout } = await exec("npm", ["exec", "--", "eve", "info", "--json"], {
        cwd: dir, timeout: 90_000, maxBuffer: 16 << 20,
      });
      const i = stdout.indexOf("{");
      const info = JSON.parse(stdout.slice(i));
      diagnostics = info.diagnostics ?? null;
    } catch (e) {
      diagnostics = { errors: -1, note: String(e.message ?? e).slice(0, 200) };
    }
    return Response.json({ ok: true, path, previous, diagnostics });
  }

  return Response.json({ error: "action must be generate or apply" }, { status: 400 });
}
