// Build chat: OpenCode (a real coding agent, local server, per-project
// session) streams progress live over NDJSON — text deltas and tool calls as
// they happen, then a final `done` frame with writes/diagnostics. The legacy
// GLM tool-loop stays as automatic fallback and answers in the same frame
// format, so the UI reads one contract.
//
// Frames: {type:"delta",text} {type:"tool",tool,path?} {type:"status",label}
//         {type:"done",text,events,writes,diagnostics,engine,model,fallbackReason?}
//         {type:"error",error}

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateText, tool, stepCountIs } from "ai";
import { createGateway } from "@ai-sdk/gateway";
import { z } from "zod";
import { resolveProject } from "../../../lib/projects.js";
import { opencodePromptStream, snapshotAgent, diffAgent, freshOidc } from "../../../lib/opencode.js";

const exec = promisify(execFile);
const DEFAULT_MODEL = "zai/glm-5.2";
const WRITE_RE = /^agent\/(tools\/[a-z0-9-]+\.(ts|js)|instructions\.md|agent\.ts)$/;
const TOOL_RE = /^agent\/tools\/[a-z0-9-]+\.(ts|js)$/;
const READ_RE = /^(agent\/[\w./-]+|package\.json)$/;

async function runDiagnostics(dir) {
  try {
    const { stdout } = await exec("npm", ["exec", "--", "eve", "info", "--json"], {
      cwd: dir, timeout: 120_000, maxBuffer: 16 << 20,
    });
    return JSON.parse(stdout.slice(stdout.indexOf("{"))).diagnostics ?? null;
  } catch (e) {
    return { errors: -1, note: String(e.message ?? e).slice(0, 160) };
  }
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

async function runLegacy(dir, messages, model, frame) {
  const token = await freshOidc(dir);
  if (!token) throw new Error("No AI Gateway credentials — press play once or run `vercel env pull`.");
  process.env.VERCEL_OIDC_TOKEN = token;
  const gateway = createGateway();

  const events = [];
  const writes = [];
  const emit = (e) => { events.push(e); frame({ type: "tool", ...e }); };

  const tools = {
    list_files: tool({
      description: "List the agent's files (tools, instructions, config).",
      inputSchema: z.object({}),
      execute: async () => {
        let t = [];
        try { t = readdirSync(join(dir, "agent", "tools")); } catch {}
        emit({ tool: "list_files" });
        return { tools: t, other: ["agent/agent.ts", "agent/instructions.md"] };
      },
    }),
    read_file: tool({
      description: "Read a file from the project (agent/** or package.json).",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        if (!READ_RE.test(path)) return { error: "path not readable" };
        emit({ tool: "read_file", path });
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
        emit({ tool: "write_file", path });
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
        emit({ tool: "delete_file", path });
        // previous rides along so the UI's Revert chip can restore the file.
        writes.push({ path, previous, deleted: true });
        return { ok: true, deleted: path };
      },
    }),
  };

  const { text } = await generateText({
    model: gateway(model || DEFAULT_MODEL),
    system: SYSTEM(dir),
    messages: (messages ?? []).map((m) => ({ role: m.role, content: m.content })),
    tools,
    stopWhen: stepCountIs(8),
  });

  let diagnostics = null;
  if (writes.length) {
    frame({ type: "status", label: "diagnostics" });
    diagnostics = await runDiagnostics(dir);
  }
  return { text, events, writes, diagnostics };
}

export async function POST(request) {
  const { project: name, messages, model, provider, engine } = await request.json();
  const project = await resolveProject(name);
  if (!project?.localPath) return Response.json({ error: "No local checkout for this project." }, { status: 409 });
  const dir = project.localPath;
  const lastUser = [...(messages ?? [])].reverse().find((m) => m.role === "user");
  if (!lastUser) return Response.json({ error: "No user message." }, { status: 400 });

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const frame = (o) => { try { controller.enqueue(enc.encode(JSON.stringify(o) + "\n")); } catch {} };
      let fallbackReason = null;

      if (engine !== "legacy") {
        const before = snapshotAgent(dir);
        try {
          const { text, events } = await opencodePromptStream(
            project, lastUser.content, { provider, model }, frame,
          );
          const writes = diffAgent(dir, before);
          let diagnostics = null;
          if (writes.length) {
            frame({ type: "status", label: "diagnostics" });
            diagnostics = await runDiagnostics(dir);
          }
          frame({ type: "done", text, events, writes, diagnostics, engine: "opencode", model: model || DEFAULT_MODEL });
          controller.close();
          return;
        } catch (e) {
          fallbackReason = String(e.message ?? e).split("\n")[0].slice(0, 200);
          console.warn("[build-chat] opencode engine failed, falling back:", fallbackReason);
        }
      }

      try {
        const r = await runLegacy(dir, messages, model, frame);
        frame({ type: "done", ...r, engine: "legacy", model: model || DEFAULT_MODEL, fallbackReason });
      } catch (e) {
        frame({ type: "error", error: `Build chat failed: ${String(e.message ?? e).replace(/\x1b\[[0-9;]*m/g, "").slice(0, 300)}` });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" },
  });
}
