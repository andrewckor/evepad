// In-process Vercel analytics client.
//
// The `workflow` CLI is a wrapper over this same library and costs ~0.91s of
// process boot per invocation, so anything on a request path talks to the world
// directly instead. Credentials come from the same two files the CLI reads:
//   ~/Library/Application Support/com.vercel.cli/auth.json   (token)
//   <linkDir>/.vercel/project.json                           (projectId, orgId)
//
// Stream reads still go through the CLI: those payloads are sealed frames
// (`encp`) whose decryption needs the run keypair, and the CLI already wires
// that pipeline up correctly.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createAnalytics, createWorld } from "@workflow/world-vercel";
import { deriveRunPayloadKeys, maybeDecrypt } from "@workflow/core/serialization";
import { ensureLinkDir } from "./projects.js";

const AUTH_PATHS = [
  join(process.env.HOME ?? "", "Library", "Application Support", "com.vercel.cli", "auth.json"),
  join(process.env.HOME ?? "", ".local", "share", "com.vercel.cli", "auth.json"),
];

let cachedToken;
function vercelToken() {
  if (cachedToken !== undefined) return cachedToken;
  cachedToken = null;
  for (const p of AUTH_PATHS) {
    if (!existsSync(p)) continue;
    try {
      const t = JSON.parse(readFileSync(p, "utf8")).token;
      if (t) { cachedToken = t; break; }
    } catch {}
  }
  return cachedToken;
}

// One client per (project, environment). Each holds a keep-alive dispatcher, so
// reusing them also reuses TLS connections across requests.
const clients = new Map();
const worlds = new Map();

async function configFor(project, environment) {
  const token = vercelToken();
  if (!token) throw new Error("No Vercel CLI token found — run `vercel login`.");

  const dir = await ensureLinkDir(project);
  const linkPath = join(dir, ".vercel", "project.json");
  if (!existsSync(linkPath)) throw new Error(`No .vercel/project.json for ${project.name}`);
  const link = JSON.parse(readFileSync(linkPath, "utf8"));

  return {
    token,
    projectConfig: {
      projectId: link.projectId,
      projectName: link.projectName ?? project.name,
      teamId: link.orgId,
      environment,
    },
  };
}

export async function analyticsFor(project, environment) {
  const key = `${project.name}:${environment}`;
  if (!clients.has(key)) clients.set(key, createAnalytics(await configFor(project, environment)));
  return clients.get(key);
}

export async function worldFor(project, environment) {
  const key = `${project.name}:${environment}`;
  if (!worlds.has(key)) worlds.set(key, createWorld(await configFor(project, environment)));
  return worlds.get(key);
}

const toU8 = (d) => (d instanceof Uint8Array ? d : Uint8Array.from(Object.values(d)));

/**
 * Read and decrypt a run's session event stream fully in-process.
 *
 * `streams.getChunks` is a paginated SNAPSHOT — unlike a stream read, it returns
 * immediately even while the session is still open, which is how Vercel's own
 * dashboard shows turn detail for live sessions. Chunks arrive as sealed frames:
 * 4-byte length prefix → `encp` ciphertext → devalue wrapper → base64 → NDJSON.
 * The run's own key material opens them (`deriveRunPayloadKeys` is documented as
 * the capability for "anywhere a run reads its own event log").
 *
 * Measured ~1.2s vs ~2.8s (closed) or a hung timeout (open) through the CLI.
 */
export async function readRunEvents(project, environment, runId) {
  const world = await worldFor(project, environment);
  const streamId = `strm_${runId.replace(/^wrun_/, "")}_user`;

  const run = await world.runs.get(runId, { resolveData: "none" });
  const material = await world.getEncryptionKeyForRun(run);
  const keys = material ? await deriveRunPayloadKeys(material) : undefined;

  const events = [];
  let cursor;
  do {
    const page = await world.streams.getChunks(runId, streamId, { limit: 1000, cursor });
    for (const c of page.data ?? []) {
      let bytes = toU8(c.data ?? c);
      // Strip the 4-byte big-endian length prefix when present.
      if (bytes.length > 4) {
        const len = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
        if (len === bytes.length - 4) bytes = bytes.subarray(4);
      }
      let plain;
      try {
        plain = await maybeDecrypt(bytes, keys);
      } catch {
        continue; // unreadable frame; skip rather than fail the whole run view
      }
      const text = Buffer.from(plain).toString("utf8");
      // devalue wrapper: devl[["Uint8Array",1],"<base64 NDJSON>"] — same shape as
      // the local world's chunk files.
      const m = text.match(/"([A-Za-z0-9+/]{40,}={0,2})"/);
      const payload = m ? Buffer.from(m[1], "base64").toString("utf8") : text;
      for (const line of payload.split("\n")) {
        const s = line.trim();
        if (!s.startsWith("{")) continue;
        try { events.push(JSON.parse(s)); } catch {}
      }
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  events.sort((a, b) => String(a.meta?.id ?? "").localeCompare(String(b.meta?.id ?? "")));
  return events;
}

// The API requires startTime and endTime together, and rejects windows beyond the
// plan's lookback (30 days) with `observability-upgrade-required`.
const MAX_LOOKBACK_MS = 30 * 864e5;
export function windowFor(ms) {
  const span = Math.min(ms ?? MAX_LOOKBACK_MS, MAX_LOOKBACK_MS);
  return {
    startTime: new Date(Date.now() - span).toISOString(),
    endTime: new Date().toISOString(),
  };
}
