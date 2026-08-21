import { test } from "node:test";
import assert from "node:assert/strict";
import { freshFailures } from "./alerts.ts";
import type { RunSession } from "./types";

const NOW = 1_000_000;
const s = (over: Partial<RunSession>): RunSession => ({
  runId: "wrun_1",
  title: "t",
  trigger: "http",
  status: "completed",
  createdAt: new Date(NOW - 60_000),
  durationMs: null,
  model: null,
  turns: 0,
  subagents: 0,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...over,
});

test("alerts only on failed, unseen, recent sessions", () => {
  const seen = new Set(["wrun_seen"]);
  const out = freshFailures(
    [
      s({ runId: "wrun_new", status: "failed" }),
      s({ runId: "wrun_seen", status: "failed" }),
      s({ runId: "wrun_old", status: "failed", createdAt: new Date(NOW - 60 * 60_000) }),
      s({ runId: "wrun_ok" }),
    ],
    seen,
    NOW,
  );
  assert.deepEqual(
    out.map((x) => x.runId),
    ["wrun_new"],
  );
});

test("exactly at the recency edge is not news", () => {
  const out = freshFailures(
    [s({ status: "failed", createdAt: new Date(NOW - 600_000) })],
    new Set(),
    NOW,
  );
  assert.equal(out.length, 0);
});
