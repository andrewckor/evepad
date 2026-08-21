import { test } from "node:test";
import assert from "node:assert/strict";
import { runHealth } from "./runs-health.ts";
import type { RunSession } from "./types";

const s = (over: Partial<RunSession>): RunSession => ({
  runId: "wrun_1",
  title: "t",
  trigger: "http",
  status: "completed",
  createdAt: new Date(0),
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

test("counts statuses and keeps completed consistent", () => {
  const h = runHealth([
    s({ status: "completed" }),
    s({ status: "failed" }),
    s({ status: "failed" }),
    s({ status: "cancelled" }),
  ]);
  assert.equal(h.failed, 2);
  assert.equal(h.cancelled, 1);
  assert.equal(h.completed, 1);
  assert.equal(h.rate, 50);
});

test("median ignores missing durations and takes the middle", () => {
  const h = runHealth([s({ durationMs: 100 }), s({ durationMs: null }), s({ durationMs: 300 })]);
  assert.equal(h.medianMs, 300); // sorted [100, 300] -> upper-middle
  assert.equal(runHealth([s({ durationMs: -5 })]).medianMs, null);
});

test("empty view is zeroed, not NaN", () => {
  const h = runHealth([]);
  assert.equal(h.rate, 0);
  assert.equal(h.medianMs, null);
  assert.equal(h.completed, 0);
});
