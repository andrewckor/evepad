// Build chat: a conversational coding agent for the eve project. The model
// (GLM via AI Gateway, the project's own OIDC creds) answers questions and
// makes changes through tools — read/list/write restricted to the agent
// surface. Every write returns the previous content so the UI can revert.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateText, tool, stepCountIs } from "ai";
import { createGateway } from "@ai-sdk/gateway";
import { z } from "zod";
import { resolveProject } from "../../../lib/projects.js";
import { opencodePrompt, snapshotAgent, diffAgent } from "../../../lib/opencode.js";

const exec = promisify(execFile);
const DEFAULT_MODEL = "zai/glm-5.2";
const WRITE_RE = /^agent\/(tools\/[a-z0-9-]+\.(ts|js)|instructions\.md|agent\.ts)$/;
const TOOL_RE = /^agent\/tools\/[a-z0-9-]+\.(ts|js)$/;
const READ_RE = /^(agent\/[\w./-]+|package\.json)$/;

function readOidc(dir) {
  try {
    return readFileSync(join(dir, ".env.local"), "utf8").match(/^VERCEL_OIDC_TOKEN="?([^"\n]+)"?/m)?.[1] ?? null;
  } catch { return null; }
}
const isExpired = (t) => {
  try { return JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()).exp * 1000 < Date.now() + 60_000; }
  catch { return true; }
};
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

const SYSTEM = (dir) => {
  const read = (p) => { try { return readFileSync(join(dir, p), "utf8"); } catch { return null; } };
  let tools = [];
  try { tools = readdirSync(join(dir, "agent", "tools")).filter((f) => /\.(ts|js)$/.test(f)); } catch {}
  return `You are the Build assistant for an eve agent (Vercel's durable agent framework), working inside its checkout.

You can answer questions about the agent and make code changes via your tools.
- Read files before editing them. Keep answers concise; use markdown.
- Tools live at agent/tools/<kebab-name>.ts (filename = tool name):
  import { defineTool } from "eve/tools"; import { z } from "zod";
  export default defineTool({ description, inputSchema: z.object({...}), execute: async (input) => jsonSerializable });
- instructions.md is the agent's system prompt; agent.ts holds defineAgent({ model }).
- write_file replaces the ENTIRE file — always write complete file content.
- delete_file removes a tool file (agent/tools/* only). When deleting a tool,
  also check agent/instructions.md for references to it and update if needed.
- Only agent/tools/*, agent/instructions.md and agent/agent.ts are writable.

Current agent: agent.ts:\n${read("agent/agent.ts") ?? "(missing)"}\ninstructions.md:\n${(read("agent/instructions.md") ?? "").slice(0, 1500)}\ntool files: ${tools.join(", ") || "(none)"}`;
};

export async function POST(request) {
  const { project: name, messages, model, provider, engine } = await request.json();
  const project = await resolveProject(name);
  if (!project?.localPath) return Response.json({ error: "No local checkout for this project." }, { status: 409 });
  const dir = project.localPath;

  // --- Primary engine: OpenCode (real coding agent, local server, own session
  // history — send only the newest user message). Falls back to the legacy
  // GLM tool-loop below if OpenCode errors, so Build never goes dark.
  let fallbackReason = null;
  if (engine !== "legacy") {
    const lastUser = [...(messages ?? [])].reverse().find((m) => m.role === "user");
    if (lastUser) {
      const before = snapshotAgent(dir);
      try {
        const { text, events } = await opencodePrompt(project, lastUser.content, { provider, model });
        const writes = diffAgent(dir, before);
        let diagnostics = null;
        if (writes.length) {
          try {
            const { stdout } = await exec("npm", ["exec", "--", "eve", "info", "--json"], {
              cwd: dir, timeout: 120_000, maxBuffer: 16 << 20,
            });
            diagnostics = JSON.parse(stdout.slice(stdout.indexOf("{"))).diagnostics ?? null;
          } catch (e) {
            diagnostics = { errors: -1, note: String(e.message ?? e).slice(0, 160) };
          }
        }
        return Response.json({ text, events, writes, diagnostics, engine: "opencode" });
      } catch (e) {
        fallbackReason = String(e.message ?? e).split("\n")[0].slice(0, 200);
        console.warn("[build-chat] opencode engine failed, falling back:", fallbackReason);
      }
    }
  }

  const token = await oidcToken(dir);
  if (!token) return Response.json({ error: "No AI Gateway credentials — press play once or run `vercel env pull`." }, { status: 409 });
  process.env.VERCEL_OIDC_TOKEN = token;
  const gateway = createGateway();

  const events = []; // surfaced to the UI as tool chips
  const writes = []; // {path, previous} for revert buttons

  const tools = {
    list_files: tool({
      description: "List the agent's files (tools, instructions, config).",
      inputSchema: z.object({}),
      execute: async () => {
        let t = [];
        try { t = readdirSync(join(dir, "agent", "tools")); } catch {}
        events.push({ tool: "list_files" });
        return { tools: t, other: ["agent/agent.ts", "agent/instructions.md"] };
      },
    }),
    read_file: tool({
      description: "Read a file from the project (agent/** or package.json).",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        if (!READ_RE.test(path)) return { error: "path not readable" };
        events.push({ tool: "read_file", path });
        try { return { content: readFileSync(join(dir, path), "utf8").slice(0, 20_000) }; }
        catch { return { error: "not found" }; }
      },
    }),
    write_file: tool({
      description: "Create or replace a file on the agent surface (agent/tools/*.ts, agent/instructions.md, agent/agent.ts). Full file content required.",
      inputSchema: z.object({ path: z.string(), code: z.string() }),
      execute: async ({ path, code }) => {
        if (!WRITE_RE.test(path)) return { error: "path not writable — agent surface only" };
        const target = join(dir, path);
        const previous = existsSync(target) ? readFileSync(target, "utf8") : null;
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, code);
        events.push({ tool: "write_file", path });
        writes.push({ path, previous });
        return { ok: true, path };
      },
    }),
    delete_file: tool({
      description: "Delete a tool file (agent/tools/* only).",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        if (!TOOL_RE.test(path)) return { error: "only agent/tools/* can be deleted" };
        const target = join(dir, path);
        if (!existsSync(target)) return { error: "not found" };
        const previous = readFileSync(target, "utf8");
        unlinkSync(target);
        events.push({ tool: "delete_file", path });
        // previous rides along so the UI's Revert chip can restore the file.
        writes.push({ path, previous, deleted: true });
        return { ok: true, deleted: path };
      },
    }),
  };

  try {
    const { text } = await generateText({
      model: gateway(model || DEFAULT_MODEL),
      system: SYSTEM(dir),
      messages: (messages ?? []).map((m) => ({ role: m.role, content: m.content })),
      tools,
      stopWhen: stepCountIs(8),
    });

    // One diagnostics pass if anything changed — cheaper than per-write.
    let diagnostics = null;
    if (writes.length) {
      try {
        const { stdout } = await exec("npm", ["exec", "--", "eve", "info", "--json"], {
          cwd: dir, timeout: 120_000, maxBuffer: 16 << 20,
        });
        diagnostics = JSON.parse(stdout.slice(stdout.indexOf("{"))).diagnostics ?? null;
      } catch (e) {
        diagnostics = { errors: -1, note: String(e.message ?? e).slice(0, 160) };
      }
    }
    return Response.json({ text, events, writes, diagnostics, model: model || DEFAULT_MODEL, engine: "legacy", fallbackReason });
  } catch (e) {
    return Response.json({ error: `Build chat failed: ${String(e.message ?? e).replace(/\x1b\[[0-9;]*m/g, "").slice(0, 300)}` }, { status: 502 });
  }
}
